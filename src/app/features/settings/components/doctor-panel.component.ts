import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import type {
  DoctorCheck,
  DoctorReport,
} from '../../../core/services/electron.service';

/**
 * Settings → Doctor. What this machine is missing, and one button that fixes it.
 *
 * REPLACES two sections and the confusion between them. **Advanced** held
 * ffmpeg, conda and the tools Python environment as text boxes with a Browse
 * button — a control that asks a person to know a path, and offers nothing at
 * all to the person whose copy is simply absent. **General Add-ons** held the
 * Foundry engine and Calibre, calling "add-on" a thing Owen is explicit the
 * system does not function without.
 *
 * THE ONE ACTION THAT MATTERS IS "GET IT AGAIN", and neither section had it.
 * `doctor:fix` re-downloads the tools environment from its GitHub release and
 * unpacks it — the same `ensureToolsEnv()` the first-run setup calls, which is
 * what Owen asked for: *"it can do it by downloading the environment from gh
 * releases again and reinstalling it, just like when they reach the original
 * setup page"*.
 *
 * REQUIRED AND OPTIONAL ARE DRAWN DIFFERENTLY, because they are different news.
 * A missing tools env means nothing renders; a missing Calibre means one import
 * path is closed and everything else is fine. Colouring them the same would
 * make the page cry wolf, and a page that cries wolf gets ignored on the day it
 * is right.
 */
@Component({
  selector: 'app-doctor-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="doc">
      @if (loading()) {
        <p class="doc-note">Checking this computer…</p>
      } @else if (error(); as message) {
        <p class="doc-bad">{{ message }}</p>
      } @else {
        @if (report()?.healthy) {
          <p class="doc-good">
            Everything BookForge needs is installed on this computer.
          </p>
        } @else {
          <p class="doc-note">
            BookForge is missing something it needs. Press Fix and it will get it.
          </p>
        }

        @for (check of checks(); track check.id) {
          <div class="doc-row" [class.bad]="check.state !== 'ok' && check.required"
               [class.warn]="check.state !== 'ok' && !check.required">
            <div class="doc-info">
              <h4>
                {{ check.name }}
                @if (!check.required) { <span class="doc-tag">optional</span> }
              </h4>
              <p class="doc-desc">{{ check.description }}</p>
              <p class="doc-detail">{{ check.detail }}</p>
              @if (check.path) { <p class="doc-path">{{ check.path }}</p> }
              @if (progress()[check.id]; as line) {
                <p class="doc-progress">{{ line }}</p>
              }
            </div>
            <div class="doc-action">
              @if (check.state === 'ok') {
                <span class="doc-ok">✓</span>
              } @else if (check.fix !== 'none') {
                <button class="doc-btn" [disabled]="busy() !== null"
                        (click)="fix(check)">
                  {{ busy() === check.id ? 'Working…' : fixLabel(check) }}
                </button>
              } @else {
                <span class="doc-manual">{{ manualWords(check) }}</span>
              }
            </div>
          </div>
        }

        <button class="doc-recheck" [disabled]="busy() !== null" (click)="refresh()">
          Check again
        </button>
      }
    </div>
  `,
  styles: [`
    /*
     * THEME VARIABLES, AND NO FALLBACK VALUES (2026-09-17).
     *
     * This shipped with hardcoded white fallbacks beside invented variable
     * names, and in dark mode every card came out white with unreadable
     * headings - because the names did not exist and the fallbacks won. That is the project's no-fallback
     * rule in CSS: a default written beside a name you did not check is a
     * default that hides the fact you got the name wrong, and it hides it
     * everywhere the real value would have been different.
     *
     * The names below are the ones in creamsicle-desktop/styles/_themes.scss.
     * If one is ever renamed this panel goes UNSTYLED, which is loud, instead of
     * quietly reverting to a light theme.
     */
    .doc { display: flex; flex-direction: column; gap: 12px; }
    .doc-note, .doc-good, .doc-bad { margin: 0 0 4px; font-size: 13px; }
    .doc-note { color: var(--text-secondary); }
    .doc-good { color: var(--success-text); }
    .doc-bad { color: var(--error-text); }
    .doc-row {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 12px 14px; border: 1px solid var(--border-default);
      border-radius: 8px; background: var(--bg-card); color: var(--text-primary);
    }
    .doc-row.bad { border-color: var(--error); background: var(--error-bg); }
    .doc-row.warn { border-color: var(--warning); background: var(--warning-bg); }
    .doc-info { min-width: 0; }
    .doc-info h4 {
      margin: 0 0 2px; font-size: 14px; color: var(--text-primary);
      display: flex; align-items: center; gap: 8px;
    }
    .doc-tag {
      font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
      padding: 1px 6px; border-radius: 10px; background: var(--bg-sunken);
      color: var(--text-tertiary); font-weight: 600;
    }
    .doc-desc { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .doc-detail { margin: 4px 0 0; font-size: 12px; color: var(--text-primary); }
    .doc-path, .doc-progress {
      margin: 3px 0 0; font-size: 11px; color: var(--text-tertiary);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .doc-action { flex: 0 0 auto; }
    .doc-ok { color: var(--success); font-size: 18px; }
    .doc-manual {
      font-size: 11px; color: var(--text-tertiary);
      max-width: 190px; display: inline-block;
    }
    .doc-btn, .doc-recheck {
      padding: 6px 14px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--border-default); background: var(--bg-input);
      color: var(--text-primary); font-size: 13px;
    }
    .doc-btn:hover:not([disabled]), .doc-recheck:hover:not([disabled]) {
      background: var(--bg-hover);
    }
    .doc-btn[disabled], .doc-recheck[disabled] { opacity: .5; cursor: default; }
    .doc-recheck { align-self: flex-start; }
  `],
})
export class DoctorPanelComponent implements OnInit, OnDestroy {
  readonly report = signal<DoctorReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** The one id being fixed, or null. One at a time, deliberately. */
  readonly busy = signal<string | null>(null);
  readonly progress = signal<Record<string, string>>({});

  readonly checks = computed<readonly DoctorCheck[]>(() => this.report()?.checks ?? []);

  private stopProgress: (() => void) | null = null;

  ngOnInit(): void {
    const api = (window as any).electron?.doctor;
    if (api?.onProgress) {
      this.stopProgress = api.onProgress((p: { id: string; message: string }) => {
        this.progress.update((all) => ({ ...all, [p.id]: p.message }));
      });
    }
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.stopProgress?.();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const api = (window as any).electron?.doctor;
      if (!api) {
        this.error.set('The Doctor is only available in the desktop app.');
        return;
      }
      const result = await api.check();
      if (!result?.success) {
        this.error.set(result?.error ?? 'This computer could not be checked.');
        return;
      }
      this.report.set(result.data as DoctorReport);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The button's words come from the FIX, never from the state — the same
   * missing thing is repaired three different ways depending on where it comes
   * from, and "Install" over a 1.8 GB download is a button that lies about what
   * it is about to do.
   */
  fixLabel(check: DoctorCheck): string {
    switch (check.fix) {
      case 'reinstall-env': return 'Download and install';
      case 'install-component': return 'Install';
      case 'run-installer': return 'Run installer';
      case 'none': return '';
    }
  }

  manualWords(check: DoctorCheck): string {
    return check.id === 'ffmpeg'
      ? 'Install ffmpeg on this computer, then press Check again.'
      : 'BookForge cannot install this one for you.';
  }

  async fix(check: DoctorCheck): Promise<void> {
    this.busy.set(check.id);
    this.progress.update((all) => ({ ...all, [check.id]: 'Starting…' }));
    try {
      const result = await (window as any).electron.doctor.fix(check.id);
      if (!result?.success) {
        this.progress.update((all) => ({
          ...all, [check.id]: result?.error ?? 'It did not finish.',
        }));
        return;
      }
      this.progress.update((all) => {
        const next = { ...all };
        delete next[check.id];
        return next;
      });
      await this.refresh();
    } catch (err) {
      this.progress.update((all) => ({ ...all, [check.id]: (err as Error).message }));
    } finally {
      this.busy.set(null);
    }
  }
}
