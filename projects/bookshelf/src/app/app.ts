import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { MiniPlayerComponent } from './player/mini-player.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, MiniPlayerComponent],
  template: `
    <router-outlet />
    <app-mini-player />
  `,
  // Fill the small viewport (svh = height with iOS toolbars visible, so content
  // never exceeds the visible area and can't cause page scroll) and clip overflow.
  // Because the body is locked (position:fixed), toolbars stay put so svh == the
  // real visible height. Routed screens scroll via their own internal containers.
  styles: [`:host { display: flex; justify-content: center; height: 100vh; height: 100svh; overflow: hidden; }`],
})
export class App implements OnInit {
  private readonly theme = inject(ThemeService);

  ngOnInit(): void {
    this.theme.init();
  }
}
