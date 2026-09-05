import { Injectable, computed, inject, signal } from '@angular/core';

import { ComponentService } from './component.service';
import { ElectronService, StartupUpgradeReport } from './electron.service';
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
  private readonly electron = inject(ElectronService);

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

  /**
   * Ids in this batch that are UPGRADES of an already-installed component,
   * mapped to the version they are moving to.
   *
   * An upgrade breaks the assumption the rest of this queue was built on —
   * "installed means done". The component IS installed and still has work to do,
   * and it stops being work when its RECORDED version reaches the target, not
   * when it merely exists. Every place that asked `isInstalled` therefore asks
   * about upgrade-ness first.
   */
  private readonly upgradeTo = signal<Record<string, string>>({});

  /** The version an upgrade item is moving to, or null when it isn't one. */
  upgradeTarget(id: string): string | null {
    return this.upgradeTo()[id] ?? null;
  }

  /**
   * What the startup update check could not find out.
   *
   * Shown in the shelf as its own row. It is deliberately NOT a modal and
   * deliberately not silent: a Foundry release published without its checksums
   * is a real refusal the user should see, and so is a GitHub that would not
   * answer — the shelf is where downloads already speak, and it can be dismissed.
   */
  readonly checkProblems = signal<string[]>([]);

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

  /**
   * The dock shows whenever a batch has items — or the update check has
   * something to report — and hasn't been dismissed.
   */
  readonly visible = computed(
    () => (this.order().length > 0 || this.checkProblems().length > 0) && !this.dismissed(),
  );

  expand(): void { this.expanded.set(true); }
  collapse(): void { this.expanded.set(false); }
  dismiss(): void { this.dismissed.set(true); }

  // ── Progress (reactive off componentService state) ─────────────────────────

  statusOf(id: string): ItemStatus {
    if (this.doneIds().has(id)) return 'done';
    // A fresh install is done once it exists. An UPGRADE is done once the
    // recorded version reaches the target — the component was already installed
    // when it was queued, so mere existence would mark it done before it started.
    if (this.isDoneOnDisk(id)) return 'done';
    if (this.failed()[id]) return 'failed';
    if (this.currentId() === id) return 'downloading';
    // In the batch but no longer selected → the user unchecked it.
    if (!this.selected().has(id)) return 'skipped';
    return 'queued';
  }

  /**
   * Has this item's work landed on disk? For an upgrade that means the installed
   * RECORD now reads the target version — the one fact that distinguishes a
   * finished upgrade from the old copy still sitting there.
   */
  private isDoneOnDisk(id: string): boolean {
    const target = this.upgradeTarget(id);
    if (target === null) return this.components.isInstalled(id);
    return this.installedVersionOf(id) === target;
  }

  /** The version installed.json records for an id, or null when nothing is recorded. */
  private installedVersionOf(id: string): string | null {
    const status = this.components.components().find((c) => c.component.id === id);
    return status?.installed?.version ?? null;
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
    // The Whisper runtime overlay pip-installs into the same env too.
    if (id === 'cuda-tts' || id === 'whisper') return true;
    const kind = this.components.components().find((c) => c.component.id === id)?.component.kind;
    // stt-model downloads spawn the bundled python (huggingface_hub), so they
    // also wait for the engine.
    return kind === 'stt-model';
  }

  private draining = false;

  /**
   * Queue the current selection's not-yet-installed items and ensure the runner
   * is draining the queue. Idempotent and INCREMENTAL — called on each setup
   * "Next", so a step's picks start downloading the moment you leave it; newly
   * added items join the live queue without restarting it.
   */
  /**
   * Download priority: GPU acceleration packs (llama-cuda, cuda-tts) are
   * prerequisites for fast AI/TTS, so they download BEFORE optional content (extra
   * voices, language packs). Lower sorts first. Keyed off the component's GPU
   * requirement so any future GPU pack is prioritized automatically.
   */
  private priorityOf(id: string): number {
    const comp = this.components.components().find((c) => c.component.id === id)?.component;
    return comp?.requirements?.gpu ? 0 : 1;
  }

  enqueueSelected(): void {
    const queued = new Set(this.order());
    const additions = this.pending().filter((id) => !queued.has(id));
    if (additions.length > 0) {
      this.order.update((o) => {
        // Append the new picks, then float necessary (GPU) items ahead of optional
        // ones. Stable within a tier so relative pick order is preserved. The runner
        // reads order each step, so the next item it starts is the highest-priority
        // one still queued (an already-in-flight item finishes — no preemption).
        const all = [...o, ...additions];
        return all
          .map((id, i) => ({ id, i }))
          .sort((a, b) => this.priorityOf(a.id) - this.priorityOf(b.id) || a.i - b.i)
          .map((x) => x.id);
      });
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

  // ── Startup upgrades ───────────────────────────────────────────────────────

  private upgradeWatchStarted = false;

  /**
   * Listen for the main process's startup update sweep and run whatever it
   * found through THIS queue — so an upgrade downloads, reports progress, and
   * can be cancelled in exactly the same shelf as everything else.
   *
   * Called once from the app shell. Subscribes FIRST and pulls afterwards: the
   * sweep is async in the main process and may have already pushed its result
   * before this renderer was listening, and a report that arrives twice is
   * idempotent here (the ids are already queued).
   */
  watchForUpgrades(): () => void {
    if (this.upgradeWatchStarted) return () => { /* already watching */ };
    this.upgradeWatchStarted = true;

    const unsubscribe = this.electron.components.onUpgradesAvailable((report) => {
      this.applyUpgradeReport(report);
    });
    void this.electron.components.upgrades().then((report) => {
      // null = the sweep has not finished; the subscription above will bring it.
      if (report) this.applyUpgradeReport(report);
    });
    return unsubscribe;
  }

  /**
   * Queue the sweep's upgrades and surface anything it could not check.
   *
   * The component list is refreshed FIRST because every decision below reads it:
   * `isDoneOnDisk` compares the recorded version against the target, and a stale
   * renderer list would either mark a pending upgrade done or leave a finished
   * one running. `refresh()` is the same call the Add-ons tab makes.
   */
  private async applyUpgradeReport(report: StartupUpgradeReport): Promise<void> {
    if (report.problems.length > 0) {
      this.checkProblems.update((existing) => {
        const merged = new Set([...existing, ...report.problems]);
        return [...merged];
      });
      this.dismissed.set(false);
    }
    if (report.upgrades.length === 0) return;

    await this.components.ensureLoaded();
    this.upgradeTo.update((map) => {
      const next = { ...map };
      for (const u of report.upgrades) next[u.id] = u.toVersion;
      return next;
    });

    // Only ids not already in the batch. A replayed report (a dev reload pushes
    // the cached one again) must not re-select an item the user just unchecked —
    // that is a decision, and re-queuing over it would make the ✕ meaningless.
    const additions = report.upgrades
      .map((u) => u.id)
      .filter((id) => !this.order().includes(id));
    if (additions.length > 0) {
      this.selectMany(additions);
      this.order.update((o) => [...o, ...additions]);
      this.dismissed.set(false);
      this.expanded.set(true);
    }
    this.cancelled = false;
    void this.drain();
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
          !this.isDoneOnDisk(id),
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

        if (this.isDoneOnDisk(curId)) {
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
