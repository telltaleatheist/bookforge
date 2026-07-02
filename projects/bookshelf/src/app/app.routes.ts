import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    // The player is an OVERLAY rendered in the outlet on top of the always-mounted
    // shelf (see App). :id is the base64url'd download path.
    path: 'play/:id',
    loadComponent: () => import('./player/player.component').then((m) => m.PlayerComponent),
  },
  {
    // The reader is also an OVERLAY over the shelf. :id is the base64url'd project id.
    path: 'read/:id',
    loadComponent: () => import('./reader/book-reader.component').then((m) => m.BookReaderComponent),
  },
  {
    // "Listen to anything": an OVERLAY that streams arbitrary text/URL/file through TTS.
    path: 'listen',
    loadComponent: () => import('./reader/listen.component').then((m) => m.ListenComponent),
  },
  {
    // Empty route: outlet renders nothing; the shelf (mounted in App) shows through.
    path: '',
    loadComponent: () => import('./shared/noop.component').then((m) => m.NoopComponent),
  },
  { path: '**', redirectTo: '' },
];
