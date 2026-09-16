import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Persist the unfinished wizard across restarts, including after library choice. */
export class FirstRunModels {
  private waiting: boolean;

  constructor(private readonly marker: string, needsSetup: boolean) {
    this.waiting = existsSync(marker) || needsSetup;
    if (this.waiting && !existsSync(marker)) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, 'Finish BookForge setup before preparing models.\n', { flag: 'wx' });
    }
  }

  get pending(): boolean { return this.waiting; }

  /** Returns true once; disk failure keeps coordination deferred. */
  complete(): boolean {
    if (!this.waiting) return false;
    unlinkSync(this.marker);
    this.waiting = false;
    return true;
  }
}
