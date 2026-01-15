import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'pdf-picker',
    pathMatch: 'full'
  },
  {
    path: 'pdf-picker',
    loadComponent: () => import('./features/pdf-picker/pdf-picker.component').then(m => m.PdfPickerComponent)
  },
  {
    path: 'home',
    loadComponent: () => import('./pages/home/home.component').then(m => m.HomeComponent)
  },
  {
    path: 'components',
    loadComponent: () => import('./pages/components/components.component').then(m => m.ComponentsComponent)
  }
];
