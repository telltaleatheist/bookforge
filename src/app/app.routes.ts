import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'studio',
    pathMatch: 'full'
  },
  {
    // Unified Library/Studio: StudioComponent opens to the Browse grid and
    // toggles to the Workspace. The old ebooks/-based Library was retired once
    // every ebook became a manifest project (Jun 2026).
    path: 'studio',
    loadComponent: () => import('./features/studio/studio.component').then(m => m.StudioComponent)
  },
  {
    path: 'library',
    redirectTo: 'studio',
    pathMatch: 'full'
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
