import { Component, computed, effect, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { ReaderService } from './services/reader.service';
import { PlayerService } from './services/player.service';
import { ServerConfigService } from './services/server-config.service';
import { ShelfComponent } from './shelf/shelf.component';
import { MiniPlayerComponent } from './player/mini-player.component';
import { MiniReaderComponent } from './reader/mini-reader.component';
import { ReaderGateComponent } from './reader/reader-gate.component';
import { ServerGateComponent } from './shared/server-gate.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ShelfComponent, MiniPlayerComponent, MiniReaderComponent, ReaderGateComponent, ServerGateComponent],
  // The shelf is the always-mounted base layer (keeps its scroll position while
  // the player is open). The router-outlet layers the player overlay on top when
  // the route is /play/:id. The mini-bar sits above the shelf when minimized.
  // The reader gate covers everything until a reader is chosen; the server gate
  // covers even that in the native app until a library server is paired.
  template: `
    <app-shelf />
    <router-outlet />
    <app-mini-player />
    <app-mini-reader />
    @if (showGate()) {
      <app-reader-gate />
    }
    @if (!cfg.configured()) {
      <app-server-gate />
    }
  `,
  styles: [`
    /* Bottom nav-rail CONTENT height (safe-area inset is added on top by the
       rail itself) + audio mini-player height, shared by the shelf, mini-player
       and mini-reader so their bottom offsets stay in lockstep. 50px matches the
       standard iOS tab-bar height; desktop gets a roomier rail. */
    :host { display: block; height: 100vh; height: 100svh; overflow: hidden; --bf-nav-h: 50px; --bf-mini-h: 84px; }
    @media (min-width: 768px) { :host { --bf-nav-h: 74px; } }
  `],
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly reader = inject(ReaderService);
  private readonly player = inject(PlayerService);
  readonly cfg = inject(ServerConfigService);

  readonly showGate = computed(() =>
    this.reader.ready() && this.reader.supported() && !this.reader.signedIn()
  );

  private booted = false;

  constructor() {
    // Boot the server-backed pieces once a server is reachable-by-config. On the
    // web that's immediately; in the native app it waits for the pairing gate.
    effect(() => {
      if (!this.cfg.configured() || this.booted) return;
      this.booted = true;
      void this.reader.init();
      // Bring back a minimized book after a refresh. Skip when the URL is already
      // /play/:id — the player component reopens it there (and would autoplay).
      if (!location.pathname.startsWith('/play/')) void this.player.restoreLast();
    });
  }

  ngOnInit(): void {
    this.theme.init();
  }
}
