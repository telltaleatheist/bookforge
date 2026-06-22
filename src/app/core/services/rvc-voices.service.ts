import { Injectable, inject, signal } from '@angular/core';
import { ElectronService, RvcVoiceStatus } from './electron.service';

/**
 * Renderer-side state for RVC enhancement voices.
 *
 * Wraps `electronService.rvc` (list/install/remove + progress) and holds the
 * voice list + base-models-ready flag as signals. Used by:
 *   - the Add-ons "Enhancement Voices" section (install/remove), and
 *   - the TTS enhancement step (the installed-voice picker).
 *
 * The RVC ENGINE itself (rvc-env) is a normal optional component handled by
 * ComponentService; these are the downloadable voice models that live beside it.
 */
@Injectable({ providedIn: 'root' })
export class RvcVoicesService {
  private readonly electron = inject(ElectronService);

  /** All catalog voices with install state. */
  readonly voices = signal<RvcVoiceStatus[]>([]);
  /** Whether the required RVC base models are present. */
  readonly baseReady = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Voice ids with an in-flight install/remove (disables their buttons). */
  private readonly busyIds = signal<Set<string>>(new Set());
  /** Latest progress message per installing voice id. */
  readonly progressById = signal<Record<string, string>>({});

  private loadPromise: Promise<void> | null = null;

  isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  progressOf(id: string): string | null {
    return this.progressById()[id] ?? null;
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update((s) => {
      const next = new Set(s);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Re-fetch the voice list + base-ready flag. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.electron.rvc.listVoices();
      this.voices.set(res.voices);
      this.baseReady.set(res.baseReady);
    } catch (err) {
      this.error.set(this.msg(err, 'Failed to load enhancement voices'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Load once (dedup) — safe to call from multiple consumers. */
  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.refresh();
    return this.loadPromise;
  }

  async install(id: string): Promise<void> {
    this.setBusy(id, true);
    this.error.set(null);
    const unsub = this.electron.rvc.onVoiceProgress((p) => {
      if (p.id === id) this.progressById.update((m) => ({ ...m, [id]: p.message }));
    });
    try {
      const res = await this.electron.rvc.installVoice(id);
      if (!res.ok) throw new Error(res.error || `Could not install ${id}`);
      await this.refresh();
    } catch (err) {
      this.error.set(this.msg(err, `Failed to install ${id}`));
    } finally {
      unsub();
      this.setBusy(id, false);
      this.progressById.update((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
  }

  async remove(id: string): Promise<void> {
    this.setBusy(id, true);
    this.error.set(null);
    try {
      const res = await this.electron.rvc.removeVoice(id);
      if (!res.ok) throw new Error(res.error || `Could not remove ${id}`);
      await this.refresh();
    } catch (err) {
      this.error.set(this.msg(err, `Failed to remove ${id}`));
    } finally {
      this.setBusy(id, false);
    }
  }

  /** Installed voices only — the set offered in the enhancement picker. */
  installedVoices(): RvcVoiceStatus[] {
    return this.voices().filter((v) => v.installed);
  }

  private msg(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  }
}
