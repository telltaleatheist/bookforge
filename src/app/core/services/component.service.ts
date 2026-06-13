import { Injectable, inject, signal } from '@angular/core';
import {
  ElectronService,
  ComponentStatus,
  SystemProfile,
  InstallProgress,
  InstallResult,
} from './electron.service';

/**
 * Renderer-side state for the optional component system (Settings → Add-ons).
 *
 * Wraps `electronService.components` (the locked IPC surface) and holds the
 * catalog × installed × compatibility list plus the machine's SystemProfile as
 * Angular signals so the Add-ons tab can render reactively.
 *
 * Acquisition modes (see docs/optional-components-design.md):
 *   - external (BYO): detect / Locate… / Remove (forget) — Phase 1 primary path.
 *   - managed (download): Install / Cancel with live InstallProgress.
 */
@Injectable({ providedIn: 'root' })
export class ComponentService {
  private readonly electron = inject(ElectronService);

  /** Catalog × installed × compatibility for every known component. */
  readonly components = signal<ComponentStatus[]>([]);
  /** The current machine's capabilities (platform, GPU/VRAM, RAM, disk). */
  readonly profile = signal<SystemProfile | null>(null);

  /** True while a refresh() round-trip is in flight (for first-load spinners). */
  readonly loading = signal(false);
  /** Last error surfaced by an action (install/locate/remove), shown in the UI. */
  readonly error = signal<string | null>(null);

  /** ids with an in-flight action (install/locate/remove/cancel) — disables buttons. */
  private readonly busyIds = signal<Set<string>>(new Set());

  /** Unsubscribe handles for active onProgress subscriptions, keyed by id. */
  private readonly progressUnsubs = new Map<string, () => void>();

  /** Dedup guard so consumers can ensureLoaded() without re-fetching. */
  private loadPromise: Promise<void> | null = null;

  isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update(set => {
      const next = new Set(set);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Replace one component's status in the list (immutably). */
  private patchComponent(id: string, patch: Partial<ComponentStatus>): void {
    this.components.update(list =>
      list.map(c => (c.component.id === id ? { ...c, ...patch } : c)),
    );
  }

  /** Reload the catalog list + system profile from the main process. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const [list, profile] = await Promise.all([
        this.electron.components.list(),
        this.electron.components.probe(),
      ]);
      this.components.set(list);
      this.profile.set(profile);
    } catch (err) {
      this.error.set(this.toMessage(err, 'Failed to load add-ons'));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Load once on first request, sharing the in-flight/settled promise. Lets
   * consumers outside the Add-ons tab (e.g. the TTS engine pickers) gate their
   * UI on availability without each triggering its own round-trip.
   */
  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.refresh();
    return this.loadPromise;
  }

  /**
   * True when a component is installed and usable (i.e. resolveEntry would
   * succeed). Reads the `components` signal, so any template or computed that
   * calls it re-renders when availability changes.
   */
  isInstalled(id: string): boolean {
    return this.components().some(c => c.component.id === id && c.state === 'installed');
  }

  /**
   * Managed install. Subscribes to onProgress, drives the matching component's
   * live `progress`/`state` as events arrive, then refreshes. A stub-URL
   * component returns `ok:false` with an error pointing at its help URL — that
   * is surfaced via `error` rather than thrown.
   */
  async install(id: string): Promise<void> {
    if (this.isBusy(id)) return;
    this.error.set(null);
    this.setBusy(id, true);

    // Optimistically flip to 'installing' so the card shows a progress bar.
    this.patchComponent(id, {
      state: 'installing',
      progress: { id, phase: 'resolve', pct: 0 },
    });

    const unsub = this.electron.components.onProgress((p: InstallProgress) => {
      if (p.id !== id) return;
      this.patchComponent(id, {
        state: p.phase === 'error' ? 'error' : p.phase === 'done' ? 'installed' : 'installing',
        progress: p,
      });
    });
    this.progressUnsubs.set(id, unsub);

    try {
      const result: InstallResult = await this.electron.components.install(id);
      if (!result.ok) {
        this.error.set(result.error || `Could not install ${id}`);
      }
    } catch (err) {
      this.error.set(this.toMessage(err, `Could not install ${id}`));
    } finally {
      this.teardownProgress(id);
      this.setBusy(id, false);
      await this.refresh();
    }
  }

  /** Abort an in-flight managed install. */
  async cancel(id: string): Promise<void> {
    this.error.set(null);
    try {
      await this.electron.components.cancel(id);
    } catch (err) {
      this.error.set(this.toMessage(err, `Could not cancel ${id}`));
    } finally {
      this.teardownProgress(id);
      this.setBusy(id, false);
      await this.refresh();
    }
  }

  /**
   * External "Locate…": open a native picker for the entry path, then record it
   * via setExternalPath (which runs the VerifySpec and throws on mismatch).
   *
   * The renderer has no generic open-file dialog, so we reuse the folder picker
   * convention already used for conda/ffmpeg/e2a in the Tools section
   * (`browseForToolPath`). For binary components we append the expected command
   * name to the chosen folder; for conda-env components the env root *is* the
   * folder, so it is used as-is.
   */
  async locate(id: string): Promise<void> {
    if (this.isBusy(id)) return;
    this.error.set(null);

    const result = await this.electron.openFolderDialog();
    if (!result.success || !result.folderPath) return;

    const status = this.components().find(c => c.component.id === id);
    const entryPath = this.deriveEntryPath(status, result.folderPath);

    this.setBusy(id, true);
    try {
      const updated = await this.electron.components.setExternalPath(id, entryPath);
      this.components.update(list =>
        list.map(c => (c.component.id === id ? updated : c)),
      );
      await this.refresh();
    } catch (err) {
      this.error.set(this.toMessage(err, `${this.nameOf(id)} did not verify at that location`));
    } finally {
      this.setBusy(id, false);
    }
  }

  /** Forget (external) or delete (managed) a component, then refresh. */
  async remove(id: string): Promise<void> {
    if (this.isBusy(id)) return;
    this.error.set(null);
    this.setBusy(id, true);
    try {
      await this.electron.components.uninstall(id);
      await this.refresh();
    } catch (err) {
      this.error.set(this.toMessage(err, `Could not remove ${this.nameOf(id)}`));
    } finally {
      this.setBusy(id, false);
    }
  }

  /** Open an external URL (help / install instructions) in the system browser. */
  openExternal(url: string): void {
    const shell = (window as unknown as { electron?: { shell?: { openExternal(u: string): void } } }).electron?.shell;
    if (shell) {
      shell.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** For a binary, the entry is the executable inside the chosen folder; for a
   *  conda-env (or anything else) the chosen folder is the entry directly. */
  private deriveEntryPath(status: ComponentStatus | undefined, folderPath: string): string {
    if (!status || status.component.kind !== 'binary') return folderPath;
    const cmd = status.component.detect?.commandNames?.[0];
    if (!cmd) return folderPath;
    const sep = folderPath.includes('\\') ? '\\' : '/';
    const isWin = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win');
    const exe = isWin && !cmd.endsWith('.exe') ? `${cmd}.exe` : cmd;
    return `${folderPath}${sep}${exe}`;
  }

  private teardownProgress(id: string): void {
    const unsub = this.progressUnsubs.get(id);
    if (unsub) {
      try { unsub(); } catch { /* ignore */ }
      this.progressUnsubs.delete(id);
    }
  }

  private nameOf(id: string): string {
    return this.components().find(c => c.component.id === id)?.component.name ?? id;
  }

  private toMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : (typeof err === 'string' ? err : fallback);
  }
}
