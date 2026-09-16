import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Persist the unfinished wizard across restarts, including after library choice. */
export class FirstRunModels {
  private waiting: boolean;
  private preparing: Promise<void> | null = null;

  constructor(private readonly marker: string, needsSetup: boolean) {
    this.waiting = existsSync(marker) || needsSetup;
    if (this.waiting && !existsSync(marker)) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'Finish BookForge setup before preparing models.\n', { flag: 'wx' });
    }
  }

  get pending(): boolean { return this.waiting && this.preparing === null; }

  /** Release admission while preparing, but retain restart/retry state until verified. */
  finish(prepare: () => Promise<void>): Promise<void> {
    if (this.preparing !== null) return this.preparing;
    if (!this.waiting) return Promise.resolve();
    this.preparing = Promise.resolve().then(prepare).then(() => { this.complete(); })
      .finally(() => { this.preparing = null; });
    return this.preparing;
  }

  /** Returns true once; disk failure keeps coordination deferred. */
  complete(): boolean {
    if (!this.waiting) return false;
    unlinkSync(this.marker);
    this.waiting = false;
    return true;
  }
}
