import { Component, computed, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { ReaderService } from './services/reader.service';
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
  styles: [`:host { display: block; height: 100vh; height: 100svh; overflow: hidden; }`],
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly reader = inject(ReaderService);

  readonly showGate = computed(() =>
    this.reader.ready() && this.reader.supported() && !this.reader.signedIn()
  );

  ngOnInit(): void {
    this.theme.init();
    void this.reader.init();
  }
}
