import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Hash routing, because a packaged renderer is loaded from file:// and a
    // path-based router would ask the filesystem for /settings.
    provideRouter(routes, withHashLocation()),
  ],
};
