import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'library',
    pathMatch: 'full'
  },
  {
    path: 'library',
    loadComponent: () => import('./features/library/library.component').then(m => m.LibraryComponent)
  },
  {
    path: 'studio',
    loadComponent: () => import('./features/studio/studio.component').then(m => m.StudioComponent)
  },
  {
    path: 'queue',
    loadComponent: () => import('./features/queue/queue.component').then(m => m.QueueComponent)
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    // Editor window - opens in separate Electron window
    path: 'editor',
    loadComponent: () => import('./features/studio/components/editor-window/editor-window.component').then(m => m.EditorWindowComponent)
  },
  {
    // Sentence alignment - opens in separate Electron window
    path: 'alignment',
    loadComponent: () => import('./features/language-learning/components/sentence-alignment/sentence-alignment.component').then(m => m.SentenceAlignmentComponent)
  }
];
