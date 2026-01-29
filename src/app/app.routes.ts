import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'library',
    pathMatch: 'full'
  },
  {
    path: 'library',
    loadComponent: () => import('./features/pdf-picker/pdf-picker.component').then(m => m.PdfPickerComponent)
  },
  {
    path: 'audiobook',
    loadComponent: () => import('./features/audiobook/audiobook.component').then(m => m.AudiobookComponent)
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
    path: 'reassembly',
    loadComponent: () => import('./features/reassembly/reassembly.component').then(m => m.ReassemblyComponent)
  },
  {
    path: 'post-processing',
    loadComponent: () => import('./features/post-processing/post-processing.component').then(m => m.PostProcessingComponent)
  },
  {
    path: 'epub-editor',
    loadComponent: () => import('./features/epub-editor/epub-editor.component').then(m => m.EpubEditorComponent)
  },
  // Legacy route for backwards compatibility
  {
    path: 'pdf-picker',
    redirectTo: 'library',
    pathMatch: 'full'
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
