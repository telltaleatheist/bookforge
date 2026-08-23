import { Routes } from '@angular/router';

import { QueuePageComponent } from './pages/queue/queue-page.component';
import { SettingsPageComponent } from './pages/settings/settings-page.component';
import { WorkspaceComponent } from './pages/workspace/workspace.component';
import { hosted } from './core/foundry';

/**
 * THE QUEUE PAGE IS NOT A ROUTE THIS WINDOW HAS WHEN IT IS SOMEBODY ELSE'S.
 *
 * Owen's standing ruling, 2026-08-21, verbatim: *"when im in bookforge, the
 * shelf shouldnt appear at all. thats the hangup. bookforge should be using its
 * own queue."* Wave 43 turned one queue surface into three — a chip, a dropdown
 * and this page — and a rule that covered one surface has to cover all three or
 * it has been quietly repealed by a redesign. The chip and the dropdown are
 * gated on their own render; a page is gated on its ROUTE, because a route can
 * be reached by ways a template cannot refuse: the File menu can push one
 * (`api.onNavigate`), and the address the window reloads on is whatever it was
 * last left at.
 *
 * `canMatch` RATHER THAN `canActivate`, deliberately. A refused `canActivate` is
 * a navigation that fails and leaves the router where it was, which for a window
 * restoring a saved URL is a window that has arrived nowhere. A refused
 * `canMatch` lets the router keep looking, so it falls through to the wildcard
 * below and lands on the workspace — which is exactly what a hosted window
 * should show. The same shape as the workspace page's own hosted branch: not an
 * error, just the room it should have been in.
 *
 * `hosted` is fixed for the life of the window (it is read once off the
 * preload's `app:hosted`), so this is a constant test and not a guard that could
 * change its mind under a person mid-session.
 */
const standaloneOnly = () => !hosted();

export const routes: Routes = [
  { path: '', component: WorkspaceComponent },
  { path: 'queue', component: QueuePageComponent, canMatch: [standaloneOnly] },
  { path: 'settings', component: SettingsPageComponent },
  { path: '**', redirectTo: '' },
];
