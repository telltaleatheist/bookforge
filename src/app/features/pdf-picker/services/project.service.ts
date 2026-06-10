import { Injectable, signal } from '@angular/core';

/**
 * ProjectService - Holds the path of the currently open project.
 *
 * All project saving/loading lives in pdf-picker.component.ts, which
 * serializes the complete editor state (chapters, metadata, corrections,
 * splits/merges, etc.). This service used to contain a parallel BFP-era
 * save/load implementation that only persisted a subset of that state;
 * it was removed because calling it would clobber complete saves with
 * partial data.
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectService {
  // Path of the currently open project (null when no project is open)
  readonly projectPath = signal<string | null>(null);

  // Clear project state
  reset(): void {
    this.projectPath.set(null);
  }
}
