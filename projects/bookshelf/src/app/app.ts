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
  // The reader gate softly prompts for a profile once a server is paired (books
  // are available to everyone, so it's skippable). The server gate is no longer a
  // startup wall — the app opens to the (empty) library and the gate is raised on
  // demand from the empty-state CTA or the top-right account menu.
  template: `
    <app-shelf />
    <router-outlet />
    <app-mini-player />
    <app-mini-reader />
    @if (showGate()) {
      <app-reader-gate />
    }
    @if (cfg.promptOpen()) {
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

  // Prompt for a profile once a server supports readers and none is active — but
  // not if the user chose to browse as guest this session (skippable, analytics-only).
  readonly showGate = computed(() =>
    this.reader.ready() && this.reader.supported() && !this.reader.signedIn() && !this.reader.dismissed()
  );

  private lastBase: string | null = null;
  private playerRestored = false;

  constructor() {
    // Boot / re-boot the server-backed pieces whenever the paired server changes.
    // On the web configured() is always true and this runs once at construction;
    // in the native app it fires when the user connects, and again on a server
    // switch — re-initializing the reader against the new server each time.
    effect(() => {
      const base = this.cfg.baseUrl(); // tracked — re-runs on a server switch
      if (!this.cfg.configured()) return;
      if (this.lastBase !== null && this.lastBase !== base) {
        this.reader.reset(); // the old token belongs to the old server
      }
      this.lastBase = base;
      void this.reader.init();
      // Bring back a minimized book after a refresh — once, on the first boot.
      // Skip when the URL is already /play/:id — the player reopens it there.
      if (!this.playerRestored) {
        this.playerRestored = true;
        if (!location.pathname.startsWith('/play/')) void this.player.restoreLast();
      }
    });
  }

  ngOnInit(): void {
    this.theme.init();
  }
}
