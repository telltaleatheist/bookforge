import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import type { HostStatus } from '@shared/host-ops';

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
  template: `
    @if (hostOps.hostStatus(); as shown) {
      @if (hostOps.opensStatus()) {
        <button type="button" class="chip live" [title]="tip(shown)" (click)="open()">
          <ng-container *ngTemplateOutlet="readout; context: { $implicit: shown }" />
        </button>
      } @else {
        <div class="chip" role="status" [title]="tip(shown)">
          <ng-container *ngTemplateOutlet="readout; context: { $implicit: shown }" />
        </div>
      }
    }

    <!--
      THE HOST'S WORDS, WRITTEN ONCE. Both chips above draw this, so a change to
      what the chip says cannot land in one of them and not the other.

      THE ORDER IS THE ORDER OF THE DECLARATION: the mark, the headline, the
      dimmer second line under it, the count of what is still waiting, and the
      progress along the bottom edge. Every part after the headline is drawn only
      when the host sent it — an absent detail is not an empty line, an absent
      count is not a zero, and an absent percent is not a bar sitting at nothing,
      which is the one reading that would be actively misleading.
    -->
    <ng-template #readout let-shown>
      <span class="mark" aria-hidden="true"></span>
      <span class="words">
        <span class="headline">{{ shown.headline }}</span>
        @if (shown.detail !== undefined) {
          <span class="detail">{{ shown.detail }}</span>
        }
      </span>
      @if (shown.pending !== undefined) {
        <span class="pending">{{ shown.pending }}</span>
      }
      @if (shown.percent !== undefined) {
        <span class="bar"><i [style.width.%]="shown.percent"></i></span>
      }
    </ng-template>
  `,
  styles: [`
    /*
      ── THE STRIP COSTS NOTHING WHEN THERE IS NOTHING TO SAY ─────────────────

      The shell lays this out as the first row of its column, above the body, so
      a chip that is up reads as part of the window's top row rather than as
      something floating over the page. Hidden it is display:none — not
      visibility, not opacity, not a zero-height box — so the layout it is not in
      is byte for byte the layout of an app nobody mounted.

      THE PADDING IS ON THE HOST rather than on the row inside it, which is what
      makes the above true: a padded wrapper that was always present would be a
      few pixels of chrome that a standalone window paid for permanently.
    */
    :host { display: none; }
    :host(.up) {
      display: flex;
      justify-content: flex-end;
      padding: 6px 12px 0;
    }

    /*
      A CHIP AND NOT A BAR. It sits at the end of its row and takes the width of
      what the host said, up to a ceiling — a full-width band would read as this
      app's own announcement (the notice line is exactly that, and looks it),
      where this is somebody else's business shown by arrangement.

      overflow:hidden is load-bearing twice: the progress line is anchored to the
      bottom edge inside it, and a headline longer than the ceiling ellipses
      instead of pushing the chip across the window.
    */
    .chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      max-width: 420px;
      padding: 5px 10px 7px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius);
      color: var(--text-secondary);
      font: inherit;
      font-size: 12px;
      text-align: left;
      overflow: hidden;
    }

    /*
      PRESSABLE ONLY WHERE THE HOST SAID SO. Everything about the affordance is
      on this class — the pointer, the lift on hover, the focus ring — so a chip
      the host gave nowhere to go is visibly a readout and not a control
      somebody has to try in order to find out.
    */
    .chip.live {
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chip.live:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .chip.live:focus-visible { outline: none; box-shadow: var(--focus-ring); }

    /*
      THE HOST'S OWN COLOUR, on the mark, the count and the progress alike. The
      token is spelled for the only kind of work a host has ever contributed, and
      what it MEANS everywhere it is used is "this belongs to the other
      application" — the tree tints host cards with it and the action menu tints
      the host's rows with it, so a person who has learned it here has learned it
      there. Foundry's own accent is deliberately not used: this chip is not this
      app talking.
    */
    .mark {
      flex: 0 0 auto;
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--audio);
    }

    .words { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .headline {
      font-size: 12px; font-weight: 600; line-height: 1.35;
      color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* The second line, dimmer — the same relation the tree's lineage line has to
       the card title above it, and the same tokens, so two surfaces describing
       the host do not invent two typographies for it. */
    .detail {
      font-size: 10.5px; line-height: 1.35;
      color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /*
      HOW MANY MORE ARE WAITING. A badge rather than a sentence, because it is a
      number and the headline is already the sentence; tabular figures so that a
      count ticking down does not shuffle the words beside it.
    */
    .pending {
      flex: 0 0 auto;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--audio-soft);
      color: var(--audio);
      font-size: 10.5px; font-weight: 600; line-height: 1.5;
      font-variant-numeric: tabular-nums;
    }

    /*
      HOW FAR ALONG, as a hairline along the bottom edge rather than as a number
      in the row. The chip is a glance; a percentage competing with the host's
      own words would make it a reading. Drawn only when the host is counting —
      see the template.

      NOTHING IS CLAMPED. The width is the number the host declared, and a host
      that said more than a hundred draws a full bar because the box is clipped,
      not because this app corrected it.
    */
    .bar {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 2px;
      background: var(--bg-input);
    }
    .bar i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--audio), var(--audio-bright));
      transition: width 200ms ease;
    }
  `],
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
