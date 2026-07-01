import { Component } from '@angular/core';

/**
 * Renders nothing. Used for the '' route so the router-outlet is empty when the
 * player overlay is closed — the shelf is always mounted at the app-root level,
 * not inside the outlet.
 */
@Component({
  selector: 'app-noop',
  standalone: true,
  template: '',
})
export class NoopComponent {}
