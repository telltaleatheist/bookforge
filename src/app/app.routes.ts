import { inject } from '@angular/core';
import { Routes, Router, CanActivateFn } from '@angular/router';
import { LibraryService } from './core/services/library.service';

/**
 * First-run gate: the main app routes require a configured library. On a true
 * first run (no library yet) we send the user to the guided Setup page — whose
 * first step is now the library-location picker — instead of flashing a half-
 * usable Studio. Waits for LibraryService to finish loading its saved settings
 * so a configured user isn't bounced on a slow startup read.
 */
const requireLibrary: CanActivateFn = async () => {
  const library = inject(LibraryService);
  const router = inject(Router);
  await library.whenReady();
  return library.isConfigured() ? true : router.parseUrl('/setup');
};

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
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/studio/studio.component').then(m => m.StudioComponent)
  },
  {
    path: 'library',
    redirectTo: 'studio',
    pathMatch: 'full'
  },
  {
    path: 'queue',
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/queue/queue.component').then(m => m.QueueComponent)
  },
  {
    path: 'settings',
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    path: 'ai-setup',
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/ai-setup/ai-setup-wizard.component').then(m => m.AiSetupWizardComponent)
  },
  {
    path: 'setup',
    loadComponent: () => import('./features/first-run-setup/first-run-setup.component').then(m => m.FirstRunSetupComponent)
  },
  {
    // Editor window - opens in separate Electron window
    path: 'editor',
    loadComponent: () => import('./features/studio/components/editor-window/editor-window.component').then(m => m.EditorWindowComponent)
  },
  {
    // Listen window (Play / Stream player) - opens in separate Electron window
    path: 'listen',
    loadComponent: () => import('./features/studio/components/listen-window/listen-window.component').then(m => m.ListenWindowComponent)
  },
  {
    // Sentence alignment - opens in separate Electron window
    path: 'alignment',
    loadComponent: () => import('./features/language-learning/components/sentence-alignment/sentence-alignment.component').then(m => m.SentenceAlignmentComponent)
  }
];
