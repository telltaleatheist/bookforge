import { Injectable, computed, inject, signal } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

/**
 * In-flight "add a version" imports, keyed by project id.
 *
 * This state deliberately does NOT live in the Versions panel component. That
 * component is inside three `@if` blocks in studio.component (main tab, versions
 * sub-panel, selected item), so switching tabs or reselecting a book DESTROYS
 * and re-creates it. When it held the state itself, an import started on
 * instance A kept feeding progress events into instance B's map — and only A ran
 * the cleanup, so B was left rendering a 100% bar that nothing would ever clear.
 * Owning it here means the bar belongs to the IMPORT, not to whichever component
 * instance happened to be alive when it started.
 */
@Injectable({ providedIn: 'root' })
export class VariantImportService {
  private readonly electron = inject(ElectronService);

  private readonly _busyPids = signal<ReadonlySet<string>>(new Set<string>());
  private readonly _progressByPid = signal<Record<string, { name: string; fraction: number }>>({});

  /** Projects with an add-version import running right now. */
  readonly busyPids = computed(() => this._busyPids());
  /** Live 0..1 transcode progress per project, for the file currently converting. */
  readonly progressByPid = computed(() => this._progressByPid());

  constructor() {
    // ONE subscription for the application's lifetime. Each event carries the
    // projectId it belongs to, so concurrent imports in different books stay
    // separate and every panel showing that book reads the same bar.
    this.electron.onImportProgress((p) => {
      if (!p.projectId) return;
      // Progress is only meaningful while that project's import is in flight.
      // ffmpeg's last `-progress` lines can land after the import already
      // finished and cleaned up; recording one then would resurrect a bar with
      // no import left to clear it.
      if (!this._busyPids().has(p.projectId)) return;
      this._progressByPid.update((m) => ({ ...m, [p.projectId!]: { name: p.name, fraction: p.fraction } }));
    });
  }

  isBusy(projectId: string): boolean {
    return this._busyPids().has(projectId);
  }

  progressFor(projectId: string): { name: string; fraction: number } | null {
    return this._progressByPid()[projectId] ?? null;
  }

  /** Mark this project's import as started — progress events now count. */
  begin(projectId: string): void {
    this._busyPids.update((s) => new Set(s).add(projectId));
  }

  /** Import over (success or failure): drop the busy flag and the bar. */
  end(projectId: string): void {
    this._busyPids.update((s) => {
      const n = new Set(s);
      n.delete(projectId);
      return n;
    });
    this.clearProgress(projectId);
  }

  /** Drop just the bar — one file of a multi-file import finished converting. */
  clearProgress(projectId: string): void {
    this._progressByPid.update((m) => {
      if (!(projectId in m)) return m;
      const { [projectId]: _drop, ...rest } = m;
      return rest;
    });
  }
}
