import { Component, computed, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { ReaderService } from './services/reader.service';
import { PlayerService } from './services/player.service';
import { ShelfComponent } from './shelf/shelf.component';
import { MiniPlayerComponent } from './player/mini-player.component';
import { MiniReaderComponent } from './reader/mini-reader.component';
import { ReaderGateComponent } from './reader/reader-gate.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ShelfComponent, MiniPlayerComponent, MiniReaderComponent, ReaderGateComponent],
  // The shelf is the always-mounted base layer (keeps its scroll position while
  // the player is open). The router-outlet layers the player overlay on top when
  // the route is /play/:id. The mini-bar sits above the shelf when minimized.
  // The reader gate covers everything until a reader is chosen.
  template: `
    <app-shelf />
    <router-outlet />
    <app-mini-player />
    <app-mini-reader />
    @if (showGate()) {
      <app-reader-gate />
    }
  `,
  styles: [`
    /* Bottom nav-rail height + audio mini-player height, shared by the shelf,
       mini-player and mini-reader so their bottom offsets stay in lockstep. The
       rail is comfy-sized on desktop, compact on mobile. */
    :host { display: block; height: 100vh; height: 100svh; overflow: hidden; --bf-nav-h: 56px; --bf-mini-h: 84px; }
    @media (min-width: 768px) { :host { --bf-nav-h: 74px; } }
  `],
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly reader = inject(ReaderService);
  private readonly player = inject(PlayerService);

  readonly showGate = computed(() =>
    this.reader.ready() && this.reader.supported() && !this.reader.signedIn()
  );

  ngOnInit(): void {
    this.theme.init();
    void this.reader.init();
    // Bring back a minimized book after a refresh. Skip when the URL is already
    // /play/:id — the player component reopens it there (and would autoplay).
    if (!location.pathname.startsWith('/play/')) void this.player.restoreLast();
  }
}
