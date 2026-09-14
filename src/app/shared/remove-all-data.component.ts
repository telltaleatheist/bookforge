import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../core/services/electron.service';
import { LibraryService } from '../core/services/library.service';

/**
 * Reusable "Remove all BookForge data" danger zone. The in-app uninstall —
 * important on macOS where there's no uninstaller script: it deletes everything
 * BookForge downloaded (engine, models, language packs, caches, settings) while
 * keeping the user's library/books. Two-step confirm to prevent an accidental
 * wipe. Surfaced on the Storage page (one copy — the Library page's duplicate
 * was deleted on 2026-09-14) and the guided Configuration page.
 *
 * IT MUST SAY WHAT IT DOES NOT TOUCH, and since 2026-09-14 that includes the
 * Crucible on this machine. `~/.crucible/{models,voices,rvc,envs}` is the
 * SERVER's store, shared with every other app on the machine (rollout ruling:
 * one Crucible per machine, and it is the shared pool) — removing it here
 * would take Foundry's weights with BookForge's, and this app does not own a
 * byte of it. Crucible's own page is where a subject is removed.
 */
@Component({
  selector: 'app-remove-all-data',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="danger-zone">
      <div class="dz-info">
        <h3>Remove all BookForge data</h3>
        <p>
          Deletes everything BookForge downloaded — the audiobook engine, voice &amp; AI
          models, language packs, GPU components, caches, and settings.
          <strong>Your library and books are kept</strong> (they’re your files, not ours),
          and so is any <strong>Crucible</strong> on this machine — its models, voices and
          job environments live in <code>~/.crucible</code>, which belongs to the server and
          is shared with every other app that uses it. Remove those from Crucible’s own page.
          @if (isMac) {
            Afterward, quit BookForge and drag it from Applications to the Trash to finish.
          } @else {
            Afterward, quit BookForge and run the Windows uninstaller to finish.
          }
        </p>
        @if (status(); as s) {
          <div class="dz-status" [class.error]="!s.ok">{{ s.message }}</div>
        }
      </div>
      <div class="dz-actions">
        <button class="dz-btn danger" (click)="remove()" [disabled]="removing()">
          {{ removing() ? 'Removing…' : 'Remove All Data…' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .danger-zone {
      display: flex; align-items: flex-start; gap: 16px;
      padding: 16px;
      border: 1px solid color-mix(in srgb, var(--error, #d9534f) 45%, var(--border-default));
      border-radius: 10px;
      background: color-mix(in srgb, var(--error, #d9534f) 7%, transparent);
    }
    .dz-info { flex: 1; min-width: 0; }
    .dz-info h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .dz-info p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
    .dz-info strong { color: var(--text-primary); }
    .dz-status { margin-top: 8px; font-size: 12px; color: var(--success, #22c55e); }
    .dz-status.error { color: var(--error, #d9534f); }
    .dz-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; }
    .dz-confirm { font-size: 12px; color: var(--text-secondary); }
    .dz-btn {
      font-size: 12px; font-weight: 600; white-space: nowrap;
      padding: 7px 14px; border-radius: 7px; border: 1px solid transparent; cursor: pointer;
    }
    .dz-btn:disabled { opacity: 0.5; cursor: default; }
    .dz-btn.danger { background: var(--error, #d9534f); color: #fff; }
    .dz-btn.danger:hover:not(:disabled) { filter: brightness(1.08); }
    .dz-btn.ghost { background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
    .dz-btn.ghost:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
  `],
})
export class RemoveAllDataComponent {
  private readonly electron = inject(ElectronService);
  private readonly library = inject(LibraryService);

  readonly isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
  readonly removing = signal(false);
  readonly status = signal<{ ok: boolean; message: string } | null>(null);

  /** Confirm → wipe → inline status on this page. Library/books kept. */
  async remove(): Promise<void> {
    const { confirmed } = await this.electron.showConfirmDialog({
      type: 'warning',
      title: 'Remove all BookForge data?',
      message: 'This deletes everything BookForge downloaded — the audiobook engine, voice & AI models, language packs, GPU components, caches, and settings.',
      detail: 'Your audiobook library and books are kept — those are your files. This cannot be undone.',
      confirmLabel: 'Remove all data',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    this.removing.set(true);
    this.status.set(null);
    // Clear the renderer-held library/onboarding config first — the main-process
    // wipe can't delete the locked Local Storage leveldb, so without this a stale
    // "onboarding complete" flag survives and the next launch skips first-run setup.
    this.library.clearStoredConfig();
    try {
      const result = await this.electron.removeAllData();
      const freed = result?.freedBytes ? ` (${this.formatBytes(result.freedBytes)} freed)` : '';
      const finishStep = this.isMac
        ? 'To finish, quit BookForge and drag it from your Applications folder to the Trash.'
        : 'To finish, quit BookForge and run the uninstaller (Windows Settings → Apps → BookForge).';
      // The inline status line below IS the receipt, and it is on the page the
      // user pressed the button on. A modal saying the same thing was a second
      // dismissal after the confirm they already gave.
      this.status.set({
        ok: true,
        message: `All BookForge data removed${freed}. Your library and books were left untouched. `
          + finishStep,
      });
    } catch (e) {
      this.status.set({ ok: false, message: `Failed to remove data: ${(e as Error).message}` });
    } finally {
      this.removing.set(false);
    }
  }

  private formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}
