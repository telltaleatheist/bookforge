import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { ShelfComponent } from './shelf/shelf.component';
import { MiniPlayerComponent } from './player/mini-player.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ShelfComponent, MiniPlayerComponent],
  // The shelf is the always-mounted base layer (keeps its scroll position while
  // the player is open). The router-outlet layers the player overlay on top when
  // the route is /play/:id. The mini-bar sits above the shelf when minimized.
  template: `
    <app-shelf />
    <router-outlet />
    <app-mini-player />
  `,
  styles: [`:host { display: block; height: 100vh; height: 100svh; overflow: hidden; }`],
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);

  ngOnInit(): void {
    this.theme.init();
  }
}
