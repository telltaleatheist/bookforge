import { Injectable, computed, inject, signal } from '@angular/core';

import { ComponentService } from './component.service';
import { RuntimeService } from './runtime.service';

export type ItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'skipped';

/**
 * First-run "select now, download at the end" model.
 *
 * The first-run setup panels run in selection mode: instead of downloading
 * inline, each downloadable component (voices, language packs, the CUDA pack) is
 * a CHECKBOX whose id is collected here. The final step calls start(), which
 * runs the whole batch SEQUENTIALLY (one componentService.install at a time, so
 * the download queue isn't overloaded), gating env-dependent items on runtime
 * readiness. The user can uncheck a queued item (it's skipped) or cancel the
 * running one at any time.
 *
 * A root singleton so the dockable progress widget (mounted in the app shell)
 * keeps showing — and the queue keeps running — after the user leaves first-run.
 */
@Injectable({ providedIn: 'root' })
export class SetupDownloadService {
  private readonly components = inject(ComponentService);
  private readonly runtime = inject(RuntimeService);

  /** Component ids the user has checked for download. */
  readonly selected = signal<Set<string>>(new Set());

  /** Batch lifecycle: idle → running → done. */
  readonly phase = signal<'idle' | 'running' | 'done'>('idle');
  /** The id order snapshotted when the batch started (drives the progress list). */
  readonly order = signal<string[]>([]);
  /** The item currently downloading, if any. */
  readonly currentId = signal<string | null>(null);
  /** Ids that finished successfully this batch. */
  readonly doneIds = signal<Set<string>>(new Set());
  /** id → error message for items that failed this batch. */
  readonly failed = signal<Record<string, string>>({});

  /** Dock widget expand/collapse + dismiss (visible only with a live batch). */
  readonly expanded = signal(true);
  private readonly dismissed = signal(false);

  private cancelled = false;

  // ── Selection ────────────────────────────────────────────────────────────

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Uncheck. If it's the item currently downloading, cancel that download too. */
  remove(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    if (this.currentId() === id) {
      void this.components.cancel(id);
    }
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  /** Number of components currently checked for download. */
  readonly count = computed(() => this.selected().size);

  /** Selected ids that aren't already installed (the real download work). */
  readonly pending = computed(() =>
    [...this.selected()].filter((id) => !this.components.isInstalled(id)),
  );

  // ── Dock visibility ──────────────────────────────────────────────────────

  /** The dock shows whenever a batch has items and hasn't been dismissed. */
  readonly visible = computed(() => this.order().length > 0 && !this.dismissed());

  expand(): void { this.expanded.set(true); }
  collapse(): void { this.expanded.set(false); }
  dismiss(): void { this.dismissed.set(true); }

  // ── Progress (reactive off componentService state) ─────────────────────────

  statusOf(id: string): ItemStatus {
    if (this.doneIds().has(id) || this.components.isInstalled(id)) return 'done';
    if (this.failed()[id]) return 'failed';
    if (this.currentId() === id) return 'downloading';
    // In the batch but no longer selected → the user unchecked it.
    if (!this.selected().has(id)) return 'skipped';
    return 'queued';
  }

  /** Live percent for the in-flight item (0–100). */
  pctOf(id: string): number {
    const st = this.components.components().find((c) => c.component.id === id);
    return st?.progress?.pct ?? 0;
  }

  /** Whole-batch percent: each done item counts 100, the current its live pct. */
  readonly aggregatePct = computed(() => {
    const ids = this.order();
    if (ids.length === 0) return 0;
    let sum = 0;
    for (const id of ids) {
      const status = this.statusOf(id);
      if (status === 'done' || status === 'skipped') sum += 100;
      else if (status === 'downloading') sum += this.pctOf(id);
    }
    return Math.round(sum / ids.length);
  });

  readonly doneCount = computed(
    () => this.order().filter((id) => this.statusOf(id) === 'done').length,
  );

  // ── Runner ─────────────────────────────────────────────────────────────────

  private needsEngine(id: string): boolean {
    const kind = this.components.components().find((c) => c.component.id === id)?.component.kind;
    return kind === 'tts-model' || kind === 'language-pack';
  }

  /** Run the selected batch sequentially. Safe to call once per batch. */
  async start(): Promise<void> {
    if (this.phase() === 'running') return;

    const ids = this.pending();
    this.order.set(ids);
    this.doneIds.set(new Set());
    this.failed.set({});
    this.dismissed.set(false);
    this.expanded.set(true);
    this.cancelled = false;

    if (ids.length === 0) {
      this.phase.set('done');
      return;
    }

    this.phase.set('running');
    for (const id of ids) {
      if (this.cancelled) break;
      if (!this.selected().has(id)) continue; // unchecked while waiting → skip

      this.currentId.set(id);

      // Voices / language packs spawn the bundled python — wait for the engine.
      if (this.needsEngine(id)) {
        await this.runtime.whenReady();
      }
      if (this.cancelled || !this.selected().has(id)) {
        this.currentId.set(null);
        continue;
      }

      await this.components.install(id);

      if (this.components.isInstalled(id)) {
        this.doneIds.update((s) => new Set(s).add(id));
      } else if (!this.cancelled) {
        this.failed.update((f) => ({ ...f, [id]: this.components.error() || 'Download failed' }));
      }
    }

    this.currentId.set(null);
    this.phase.set('done');
  }

  /** Stop the whole batch: cancel the in-flight download and drop the queue. */
  cancelAll(): void {
    this.cancelled = true;
    const cur = this.currentId();
    if (cur) void this.components.cancel(cur);
  }
}
