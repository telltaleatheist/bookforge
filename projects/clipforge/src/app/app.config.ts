import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';

/**
 * ClipForge is a single-window desktop app driven entirely by Electron IPC
 * (window.clipforge) — no router and no HttpClient in phase 1. Zoneless change
 * detection matches the bookshelf app's configuration style.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
  ],
};
