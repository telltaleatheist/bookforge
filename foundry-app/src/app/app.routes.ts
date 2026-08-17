import { Routes } from '@angular/router';

import { SettingsPageComponent } from './pages/settings/settings-page.component';
import { WorkspaceComponent } from './pages/workspace/workspace.component';

export const routes: Routes = [
  { path: '', component: WorkspaceComponent },
  { path: 'settings', component: SettingsPageComponent },
  { path: '**', redirectTo: '' },
];
