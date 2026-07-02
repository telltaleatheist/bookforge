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
    // Import→edit: an OVERLAY where a freshly-ingested URL/file is trimmed into
    // blocks + chapters, then finalized into a persisted project. Blocks arrive
    // via router state from the shelf's ＋ import sheet.
    path: 'edit',
    loadComponent: () => import('./editor/import-editor.component').then((m) => m.ImportEditorComponent),
  },
  {
    // PDF page-crop editor: trim headers/footers/page-numbers via block boxes on
    // rasterized pages, mark chapters, then finalize like the flow editor. Pages
    // arrive via router state from the ＋ import sheet.
    path: 'edit-pdf',
    loadComponent: () => import('./editor/pdf-editor.component').then((m) => m.PdfEditorComponent),
  },
  {
    // Read&Listen: an OVERLAY that renders a project book's text and streams it
    // (follow-along) or renders the whole book to an m4b. :id is the projectId.
    path: 'book/:id',
    loadComponent: () => import('./reader/book-listen.component').then((m) => m.BookListenComponent),
  },
  {
    // Empty route: outlet renders nothing; the shelf (mounted in App) shows through.
    path: '',
    loadComponent: () => import('./shared/noop.component').then((m) => m.NoopComponent),
  },
  { path: '**', redirectTo: '' },
];
