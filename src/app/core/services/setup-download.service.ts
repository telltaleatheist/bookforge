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

  /** Check every given id (a page's "Select all"). */
  selectMany(ids: string[]): void {
    this.selected.update((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  /** Uncheck every given id (a page's "Deselect all"). */
  deselectMany(ids: string[]): void {
    this.selected.update((s) => {
      const next = new Set(s);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  /** True when every id is checked (drives the Select-all/Deselect-all label). */
  allSelectedAmong(ids: string[]): boolean {
    if (ids.length === 0) return false;
    const s = this.selected();
    return ids.every((id) => s.has(id));
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
    // CUDA TTS pip-installs PyTorch into the bundled env, so the env must be
    // unpacked first (same gating as voices/language packs that spawn its python).
    if (id === 'cuda-tts') return true;
    const kind = this.components.components().find((c) => c.component.id === id)?.component.kind;
    return kind === 'tts-model' || kind === 'language-pack';
  }

  private draining = false;

  /**
   * Queue the current selection's not-yet-installed items and ensure the runner
   * is draining the queue. Idempotent and INCREMENTAL — called on each setup
   * "Next", so a step's picks start downloading the moment you leave it; newly
   * added items join the live queue without restarting it.
   */
  enqueueSelected(): void {
    const queued = new Set(this.order());
    const additions = this.pending().filter((id) => !queued.has(id));
    if (additions.length > 0) {
      this.order.update((o) => [...o, ...additions]);
      this.dismissed.set(false);
      this.expanded.set(true);
    }
    this.cancelled = false;
    void this.drain();
  }

  /** Back-compat alias: start the current selection downloading now. */
  start(): void {
    this.enqueueSelected();
  }

  /** The next queued item still worth installing, or null when the queue is dry. */
  private nextToRun(): string | null {
    return (
      this.order().find(
        (id) =>
          !this.cancelled &&
          this.selected().has(id) &&
          !this.doneIds().has(id) &&
          !this.failed()[id] &&
          !this.components.isInstalled(id),
      ) ?? null
    );
  }

  /**
   * Drain the queue sequentially (one componentService.install at a time so the
   * connection isn't overloaded). Re-reads the order each step, so items
   * enqueued mid-run are picked up. Only one drain runs at a time.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    if (this.order().length > 0) this.phase.set('running');
    try {
      let id: string | null;
      while ((id = this.nextToRun()) !== null) {
        const curId: string = id;

        // Voices / language packs / CUDA-TTS spawn the bundled python — wait for
        // the engine to finish setting up BEFORE marking the item active, so it
        // shows "Queued" (not a stuck "downloading 0%") while the engine unpacks.
        if (this.needsEngine(curId)) {
          await this.runtime.whenReady();
        }
        if (this.cancelled || !this.selected().has(curId)) {
          continue;
        }

        this.currentId.set(curId);
        await this.components.install(curId);

        if (this.components.isInstalled(curId)) {
          this.doneIds.update((s) => new Set(s).add(curId));
        } else if (!this.cancelled) {
          this.failed.update((f) => ({ ...f, [curId]: this.components.error() || 'Download failed' }));
        }
        this.currentId.set(null);
      }
    } finally {
      this.currentId.set(null);
      this.draining = false;
      this.phase.set('done');
    }
  }

  /** Stop the whole batch: cancel the in-flight download and drop the queue. */
  cancelAll(): void {
    this.cancelled = true;
    const cur = this.currentId();
    if (cur) void this.components.cancel(cur);
  }
}
