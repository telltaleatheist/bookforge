import { Injectable, inject, signal } from '@angular/core';
import {
  ElectronService,
  ComponentStatus,
  SystemProfile,
  InstallProgress,
  InstallResult,
  EnvDiagnosticResult,
} from './electron.service';
import { RuntimeService } from './runtime.service';

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
  private readonly runtime = inject(RuntimeService);

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

  /** Ids of external tools with a downloadable installer for this OS. */
  private readonly installerIds = signal<Set<string>>(new Set());
  private readonly installerNotes = signal<Record<string, string | null>>({});

  /** True when the component has a one-click "Download & Install" path here. */
  hasInstaller(id: string): boolean {
    return this.installerIds().has(id);
  }

  /** Reload the catalog list + system profile from the main process. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    // Populate each piece AS IT RESOLVES rather than gating all on Promise.all.
    // The component LIST (which drives the voice/add-on UI) is fast, but the
    // system PROBE (nvidia-smi / disk) can take many seconds — worst during the
    // busy first-run download window. Decoupling means voices render the moment
    // the list returns instead of waiting behind the probe. The probe + installer
    // hints fill in independently and their failure is non-fatal to the list.
    const listP = this.electron.components.list()
      .then((list) => this.components.set(list))
      .catch((err) => { this.error.set(this.toMessage(err, 'Failed to load add-ons')); });
    const probeP = this.electron.components.probe()
      .then((profile) => this.profile.set(profile))
      .catch(() => { /* probe failure is non-fatal — the list still renders */ });
    const instP = this.electron.components.installers()
      .then((installers) => {
        this.installerIds.set(new Set(installers.ids));
        this.installerNotes.set(installers.notes);
      })
      .catch(() => { /* installer hints are optional */ });
    try {
      await Promise.all([listP, probeP, instP]);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Download the right OS installer for an external tool and launch it. Unlike
   * install(), it never flips the card to "installed" on its own — the OS does
   * the install out-of-band — so we re-probe afterward and let detection decide.
   */
  async runInstaller(id: string): Promise<void> {
    if (this.isBusy(id)) return;
    this.error.set(null);
    this.setBusy(id, true);
    this.patchComponent(id, { state: 'installing', progress: { id, phase: 'download', pct: 0 } });

    const unsub = this.electron.components.onProgress((p: InstallProgress) => {
      if (p.id !== id) return;
      this.patchComponent(id, {
        state: p.phase === 'error' ? 'error' : 'installing',
        progress: p,
      });
    });
    this.progressUnsubs.set(id, unsub);

    try {
      const result = await this.electron.components.runInstaller(id);
      if (!result.ok) {
        this.error.set(result.error || `Could not download the ${id} installer`);
      } else {
        const note = this.installerNotes()[id];
        await this.electron.showMessageDialog({
          type: 'info',
          title: 'Installer launched',
          message: note || 'The installer was downloaded and opened. Complete it, then click Locate if it isn’t detected automatically.',
        });
      }
    } catch (err) {
      this.error.set(this.toMessage(err, `Could not download the ${id} installer`));
    } finally {
      this.teardownProgress(id);
      this.setBusy(id, false);
      await this.refresh(); // re-probe so the card reflects the real state
    }
  }

  /**
   * Load once on first request, sharing the in-flight/settled promise. Lets
   * consumers outside the Add-ons tab (e.g. the TTS engine pickers) gate their
   * UI on availability without each triggering its own round-trip.
   */
  ensureLoaded(): Promise<void> {
    // Re-fetch if nothing has loaded yet, or the previous attempt errored (e.g.
    // the list IPC failed during the busy first-run window). Otherwise a cached
    // failed/empty load would leave the panel permanently blank with no retry.
    if (!this.loadPromise || (this.error() && !this.loading())) {
      this.loadPromise = this.refresh();
    }
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

    // Voice + language-pack downloads spawn the bundled env's python. During the
    // first-run unpack that python doesn't exist yet, so gate them on runtime
    // readiness with a friendly message instead of a confusing ENOENT. Archive
    // installs (Calibre/Orpheus tarballs) don't need the env and aren't gated.
    const kind = this.components().find(c => c.component.id === id)?.component.kind;
    if ((kind === 'tts-model' || kind === 'language-pack' || kind === 'stt-model') && !this.runtime.ready()) {
      this.error.set('The audiobook engine is still setting up — this download will be available in a moment.');
      return;
    }

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
   * Auto-find an external tool in the platform's common install locations
   * (env var → PATH → known candidate paths, via the backend DetectSpec). On a
   * hit, verify + record it and return true. Returns false when nothing is found
   * (the caller then offers manual entry / browse). Detection failures are an
   * expected "not found" outcome, not an error to surface.
   */
  /** Run env_diagnostics.py inside a component's env and return its per-check
   *  report (or an error result). Used by the "Test environment" button. */
  async testEnv(id: string): Promise<EnvDiagnosticResult> {
    return this.electron.components.testEnv(id);
  }

  async autoLocate(id: string): Promise<boolean> {
    if (this.isBusy(id)) return false;
    this.error.set(null);
    this.setBusy(id, true);
    try {
      const found = await this.electron.components.detectExternal(id);
      if (!found) return false;
      const updated = await this.electron.components.setExternalPath(id, found);
      this.components.update(list => list.map(c => (c.component.id === id ? updated : c)));
      await this.refresh();
      return true;
    } catch {
      // Detected a path but it failed to verify → treat as not-found; the user
      // can point at the right one manually.
      return false;
    } finally {
      this.setBusy(id, false);
    }
  }

  /**
   * Record a user-typed path to an external tool's executable. Runs the
   * VerifySpec via setExternalPath; on mismatch surfaces the error and returns
   * false so the inline form stays open.
   */
  async setManualPath(id: string, entryPath: string): Promise<boolean> {
    const trimmed = entryPath.trim();
    if (!trimmed) return false;
    this.error.set(null);
    this.setBusy(id, true);
    try {
      const updated = await this.electron.components.setExternalPath(id, trimmed);
      this.components.update(list => list.map(c => (c.component.id === id ? updated : c)));
      await this.refresh();
      return true;
    } catch (err) {
      this.error.set(this.toMessage(err, `${this.nameOf(id)} did not verify at that location`));
      return false;
    } finally {
      this.setBusy(id, false);
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
  async locate(id: string): Promise<boolean> {
    if (this.isBusy(id)) return false;
    this.error.set(null);

    const result = await this.electron.openFolderDialog();
    if (!result.success || !result.folderPath) return false;

    const status = this.components().find(c => c.component.id === id);
    const entryPath = this.deriveEntryPath(status, result.folderPath);

    this.setBusy(id, true);
    try {
      const updated = await this.electron.components.setExternalPath(id, entryPath);
      this.components.update(list =>
        list.map(c => (c.component.id === id ? updated : c)),
      );
      await this.refresh();
      return true;
    } catch (err) {
      this.error.set(this.toMessage(err, `${this.nameOf(id)} did not verify at that location`));
      return false;
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
