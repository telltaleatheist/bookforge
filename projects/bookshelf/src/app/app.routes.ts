import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./shelf/shelf.component').then((m) => m.ShelfComponent),
  },
  {
    // The full-page player. :id is the audiobook's download path (Angular
    // URL-encodes the slashes), resolved against /api/books on load.
    path: 'play/:id',
    loadComponent: () => import('./player/player.component').then((m) => m.PlayerComponent),
  },
  { path: '**', redirectTo: '' },
];
