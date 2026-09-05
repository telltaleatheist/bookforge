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
    path: 'live-tts',
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/live-tts/live-tts.component').then(m => m.LiveTtsComponent)
  },
  {
    path: 'enhance',
    canActivate: [requireLibrary],
    loadComponent: () => import('./features/enhance/enhance.component').then(m => m.EnhanceComponent)
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
    // Listen window (Play / Stream player) - opens in separate Electron window
    path: 'listen',
    loadComponent: () => import('./features/studio/components/listen-window/listen-window.component').then(m => m.ListenWindowComponent)
  },
  {
    // A bench for the live-DOM EPUB viewer, not part of the app's navigation.
    // `/#/epub-viewer-harness?book=<path>` opens a real EPUB through quire and
    // drives the component directly. The picker that used to host the viewer is
    // gone (Foundry is the one editing surface); this bench is now the only
    // renderer-side driver of `quire-viewer-bridge`, and it is how the viewer is
    // exercised against a real book.
    path: 'epub-viewer-harness',
    loadComponent: () => import(
      './features/epub-viewer/epub-viewer-harness.component'
    ).then(m => m.EpubViewerHarnessComponent)
  }
];
