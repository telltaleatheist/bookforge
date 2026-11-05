import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { QueueService } from '../../core/queue.service';
import { QueueViewService } from '../../core/queue-view.service';
import { UiService } from '../../core/ui.service';
import { hosted } from '../../core/foundry';

/**
 * THE QUEUE BAR — the chip in the window's top-right corner, and the panel it
 * opens.
 *
 * Owen's ruling, 2026-08-22, verbatim:
 *
 *   *"looks like we didnt implement a bookforge-style queue. can you make the
 *   queue shelf a bar along the top right that i can click and look at, and put
 *   a button in it for 'more info' thatll take me to a queue page that looks
 *   like bookforge's queue page? this is just ui work mostly, not changing the
 *   way it works on an engine level."*
 *
 * The last sentence is the fence and it was kept: the scheduler, the slot table,
 * the drain contract, the held/Start semantics and every door on `QueueService`
 * are untouched. What changed is where the same facts are drawn.
 *
 * ── THE GRAVESTONE: the bottom-right shelf, and where each of its jobs went ──
 *
 * `QueueShelfComponent` is deleted. It was a pill docked in the bottom-right
 * corner that unrolled upward, modelled on BookForge's setup-download dock —
 * which, it turns out, is the wrong BookForge component to have copied: that one
 * is the first-run DOWNLOAD dock, and BookForge's actual queue is a chip in the
 * title bar with a dropdown under it and a page behind that. Owen noticed. So
 * this is not a redesign of the shelf; it is the shelf finally being modelled on
 * the thing it was always meant to resemble.
 *
 * NOT ONE OF ITS BEHAVIOURS DIED. Every one is named here so that a person
 * looking for the shelf finds out where its job went rather than whether it had
 * one:
 *
 *   the collapsed pill's headline    → the chip's line, from the same computed
 *                                      (`QueueViewService.headline`, moved
 *                                      wholesale, not respelled)
 *   the aggregate bar following GPU  → the hairline along the chip's bottom edge
 *   the expanded board               → this panel, and the queue page
 *   the two-meaning ✕                → unchanged in both surfaces: a running job
 *                                      is CANCELLED, a held or queued one is
 *                                      REMOVED, and the titles still say which
 *   Start, carrying the count        → this panel's foot, and the page's head
 *   Clear finished                   → beside it, in both
 *   the export-done unroll           → opens this panel (see the constructor)
 *   `focusShelfAt` → Start           → `focusStartAt`, focusing Start in here
 *   the sr-only live region          → the first element in this template
 *   `@if (!hosted())`                → unchanged, absolutely: see below
 *
 * And one thing was deliberately NOT carried: the shelf drew nothing at all with
 * an empty queue. This chip is always there standalone, because a bar you can
 * *"click and look at"* is not a bar that disappears when there is nothing in
 * it — and because the panel is where Start lives, so a queue you cannot open
 * when it is empty is one you cannot begin. BookForge's own empty chip is a
 * quiet glyph reading "Queue" for exactly that reason, and this one is too. The
 * price is real and is named: the standalone window's top row costs about 34
 * pixels now, where it cost nothing before.
 *
 * ── HOSTED, THERE IS NO QUEUE SURFACE OF FOUNDRY'S. NONE. ───────────────────
 *
 * Owen's earlier ruling, 2026-08-21, verbatim: *"when im in bookforge, the shelf
 * shouldnt appear at all. thats the hangup. bookforge should be using its own
 * queue."* That survives this wave without a scratch, and it now covers three
 * surfaces instead of one: this chip, this panel and the queue page are all
 * behind the same gate. The hosted window's queue IS the host's, its rows draw
 * in the host's own chrome, and its held reads are released from the host's own
 * queue page.
 *
 * The corner this chip sits in is the corner the HOST STATUS CHIP has hosted
 * (Wave 14) — and the two can never collide, because each is drawn in exactly
 * the world the other is not: the host's chip has nothing to say standalone (no
 * host ever pushes, its host element is display:none), and this one is not
 * rendered hosted at all.
 *
 * ── The panel is a plain anchored box and not an overlay ────────────────────
 *
 * BookForge parents its tray in a CDK overlay, for a reason that is about its
 * window and not about ours: its chip sits in a 40px title bar with its own
 * stacking context and `-webkit-app-region: drag`, so a child panel would be
 * clipped, would sit under the window body, and would be DRAGGABLE. Foundry's
 * top row is an ordinary flex row of the shell with nothing clipping it, so an
 * absolutely-positioned child is the whole mechanism — and this app has no CDK
 * dependency, which is not a thing to add for one dropdown.
 */
@Component({
  selector: 'app-queue-bar',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Reflected onto the host so the row can take itself out of the shell's
  // layout hosted, exactly the way the host status chip does — see the styles.
  host: { '[class.up]': '!hosted()' },
  templateUrl: './queue-bar.component.html',
  styleUrl: './queue-bar.component.scss',
})
export class QueueBarComponent {
  /** Hosted, the whole component renders nothing — see the class docblock. */
  protected readonly hosted = hosted;
  protected readonly queue = inject(QueueService);
  protected readonly view = inject(QueueViewService);
  protected readonly ui = inject(UiService);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly start = viewChild<ElementRef<HTMLButtonElement>>('start');

  constructor() {
    /*
     * FOCUS ARRIVES FROM THE OCR DIALOG, one press at a time.
     *
     * The counter is read and the button is focused in a microtask, because the
     * panel may have been shut a moment ago: `summonQueue` opens it in the same
     * tick, and the button does not exist in the DOM until that render has
     * happened. Focusing a button that is not there yet silently does nothing,
     * which is the failure this ordering exists to avoid.
     *
     * IT DOES NOT FIGHT THE PANEL'S OWN FOCUS. Opening the panel by CLICKING the
     * chip focuses the panel container, so Escape has somewhere to land; that
     * happens in `toggle` rather than in an effect precisely so this path — the
     * one that wants Start under the finger — is never overwritten by it.
     */
    effect(() => {
      if (this.ui.focusStartAt() === 0) return;
      queueMicrotask(() => this.start()?.nativeElement.focus());
    });

    /*
     * A FINISHED EXPORT OPENS THE PANEL. Every other job's completion is
     * background news — a cast, a facsimile, a translation whose book follows
     * in a tab — but an export IS the deliverable, and finishing one behind a
     * shut panel was the app whispering "exported" with the file nowhere in
     * reach (user report, 2026-08-16). The transition is watched per job id so
     * a panel the person closes afterwards stays closed; only the moment of
     * arrival opens it, with the row's Save… and ↗ on it.
     */
    const seen = new Map<string, string>();
    effect(() => {
      for (const job of this.queue.jobs()) {
        const was = seen.get(job.id);
        seen.set(job.id, job.state);
        if (was !== undefined && was !== 'done' && job.state === 'done' && this.view.filed(job)) {
          this.ui.queueOpen.set(true);
        }
      }
    });
  }

  /** Nothing has ever been in this queue, which is the chip's quietest state. */
  protected readonly empty = computed(() => this.queue.jobs().length === 0);

  /**
   * The chip, said aloud. The headline is a phrase rather than a sentence and
   * ends with what pressing it does, because a screen reader arriving at a
   * button in a corner has no other way to learn that it opens something.
   */
  protected readonly chipLabel = computed(() => {
    const verb = this.ui.queueOpen() ? 'Close' : 'Open';
    if (this.empty()) return `Queue is empty. ${verb} the queue.`;
    return `Queue: ${this.view.headline()}. ${verb} the queue.`;
  });

  /**
   * The chip's press.
   *
   * The panel takes focus as it opens so that Escape reaches it without the
   * user tabbing to it — BookForge does the same thing as its overlay attaches,
   * and for the same reason. In a microtask because the panel is not in the DOM
   * until this signal's render has happened.
   */
  protected toggle(): void {
    const open = !this.ui.queueOpen();
    this.ui.queueOpen.set(open);
    if (open) queueMicrotask(() => this.panel()?.nativeElement.focus());
  }

  /**
   * More info was pressed. The router does the navigating (it is a link); this
   * only shuts the panel, because a dropdown still hanging over the page it
   * just sent you to is a dropdown you have to dismiss before you can read what
   * you asked for.
   */
  protected goPage(): void {
    this.ui.queueOpen.set(false);
  }

  /**
   * ESCAPE SHUTS IT, which is the promise every overlay in this app makes.
   *
   * On the document rather than on the panel: focus may legitimately have moved
   * out of the panel by the time somebody presses Escape — into the chip, or
   * nowhere at all after a row's ✕ removed the element that had it — and a
   * panel that only closes while it happens to hold focus is one that gets
   * stuck open.
   */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.ui.queueOpen()) return;
    this.ui.queueOpen.set(false);
  }

  /**
   * A CLICK ANYWHERE ELSE SHUTS IT — the other half of "click and look at".
   *
   * The chip's own click is excluded by the containment test rather than by a
   * stopPropagation on the button: the panel is full of controls, several of
   * which remove the element they are on, and a swallowed event is a bug that
   * only shows up in the one gesture nobody tried. Anything inside this
   * component's host is the panel's own business; everything else is a person
   * looking away.
   */
  @HostListener('document:pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent): void {
    if (!this.ui.queueOpen()) return;
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) return;
    this.ui.queueOpen.set(false);
  }
}
