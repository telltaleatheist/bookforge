import { AfterViewInit, Directive, inject, OnDestroy } from '@angular/core';
import { PlayerService } from '../services/player.service';

/**
 * Marks an element as a transport view: the play/pause controls a listener can
 * reach. PlayerService never starts audio on its own while no transport view is
 * on screen (see PlayerService.mayStart), so this goes on the element that holds
 * the play/pause button — the full player's transport row and the mini-bar —
 * and nowhere else.
 *
 * "On screen" means PAINTED, not merely created: the view registers two animation
 * frames after it is initialised (the first frame is the one that paints it; the
 * second runs after that paint). Registering in ngAfterViewInit alone let the
 * audio start in the same task that built a multi-thousand-row transcript, i.e.
 * seconds before the controls actually appeared. A backgrounded page runs no
 * frames, so a view built while hidden registers when the user comes back to it.
 */
@Directive({ selector: '[bfTransport]', standalone: true })
export class TransportPresenceDirective implements AfterViewInit, OnDestroy {
  private readonly player = inject(PlayerService);
  private frame = 0;
  private detach: (() => void) | null = null;

  ngAfterViewInit(): void {
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.detach = this.player.attachTransport();
      });
    });
  }

  ngOnDestroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.detach?.();
    this.detach = null;
  }
}
