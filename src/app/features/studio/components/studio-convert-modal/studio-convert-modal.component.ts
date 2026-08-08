/**
 * studio-convert-modal — watching a book being read.
 *
 * Owen's design, 2026-08-07: converting a PDF into this project's book is an
 * action on the VERSIONS page, not in the picker, and it is the only route from
 * a PDF to a book. `foundry vlm-convert` hands each page picture to a document
 * vision model and assembles the answers; on the M1 Ultra that is about eighteen
 * seconds a page, so a 300-page book is an hour and a half.
 *
 * Which makes the two things this window has to get right obvious:
 *
 *  - **Say which machine is doing it.** The same PDF read by MLX here and by a
 *    vLLM on somebody's 3090 produces the same book at wildly different speed,
 *    and "which one ran" is the first question about a conversion that is taking
 *    too long or came out wrong.
 *  - **Let the user leave.** Nobody watches a bar for ninety minutes. Run in
 *    background closes this window and nothing else — the run is owned by MAIN
 *    (`withProjectStage`) and by `BookConversionService` in the renderer, so
 *    neither closing this nor reloading ng-serve touches it, and the versions row
 *    keeps a live indicator that opens this window again.
 *
 * It owns NO state of its own. Everything on screen is `BookConversionService`'s
 * one run, which is also what the versions row reads — one run, two views, and
 * no way for them to disagree about whether something is happening.
 */
import { Component, HostListener, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { BookConversionService, type ConversionRun } from '../../services/book-conversion.service';
import { conversionEtaSeconds, formatEta, formatPageRate } from '@shared/vlm/eta';

@Component({
  selector: 'app-studio-convert-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="backdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="convert-modal-title">
        <header class="modal-head">
          <div class="head-copy">
            <div class="eyebrow">Convert to EPUB</div>
            <h2 id="convert-modal-title">{{ run()?.sourceLabel || 'Reading the pages' }}</h2>
          </div>
        </header>

        @if (run(); as r) {
          <div class="modal-body">
            <div class="route">
              <span class="route-icon">🖥️</span>
              <div class="route-copy">
                <span class="route-kicker">Reading the pages on</span>
                <strong>{{ r.route }}</strong>
              </div>
            </div>

            <!-- Indeterminate until foundry names a page count. A bar sitting at
                 0% for the model-load minute reads as a stall; a bar that is
                 obviously "working on it" does not claim a number nobody has. -->
            <div class="bar" [class.waiting]="r.total === 0"
                 role="progressbar" [attr.aria-valuenow]="r.total > 0 ? r.done : null"
                 [attr.aria-valuemin]="0" [attr.aria-valuemax]="r.total || null">
              <div class="fill" [style.width.%]="r.total > 0 ? percent() : 100"></div>
            </div>
            <div class="counts">
              @if (r.total > 0) {
                <span class="pages">{{ r.done }} of {{ r.total }} pages</span>
                <span class="pct">{{ percent() }}%</span>
              } @else {
                <span class="pages">Loading the model and rendering the first page…</span>
              }
            </div>
            @if (rateLine(); as rate) {
              <div class="counts eta"><span>{{ rate }}</span></div>
            }

            <!-- foundry's own line, verbatim. It names the page, its size and how
                 many characters came back, which is the only running evidence
                 that the model is reading rather than repeating itself. -->
            <div class="line" [title]="r.message">{{ r.message }}</div>

            @if (r.from === 'working') {
              <div class="note">
                The pages you deleted in your working copy are being left out. Everything else in the
                original is read.
              </div>
            }

            <div class="note patience">
              Every page is banked as it is read — stopping costs only the page in flight, and
              converting again resumes from there.
            </div>
          </div>

          <footer class="modal-actions">
            @if (r.phase === 'ready') {
              <!-- Nothing has been spawned. Closing throws the intent away, which
                   is why neither of these is the close button. -->
              <button class="stop-btn" type="button" (click)="dismiss()">Cancel</button>
              <button class="queue-btn" type="button" (click)="addToQueue()">Add to queue</button>
              <button class="bg-btn" type="button" (click)="begin()">Start</button>
            } @else {
              <button class="stop-btn" type="button" [disabled]="r.stopping" (click)="stop()">
                {{ r.stopping ? 'Stopping…' : 'Cancel' }}
              </button>
              <!-- The stage belongs to main and broadcasts to every window, so
                   this interrupts nothing: the queue row attaches to the run
                   already happening and becomes where it is watched. -->
              <button class="bg-btn" type="button" (click)="addToQueue()">Send to queue</button>
            }
          </footer>
        } @else {
          <!-- The run ended while this window was open. It is not closed from
               underneath the user: the outcome was announced in its own dialog,
               and this stays until they dismiss it. -->
          <div class="modal-body">
            <div class="note">This conversion has finished. The book row appears on the versions
              list below.</div>
          </div>
          <footer class="modal-actions">
            <button class="bg-btn" type="button" (click)="close.emit()">Close</button>
          </footer>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }
    .backdrop { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px;
      background: rgba(5, 8, 14, 0.72); backdrop-filter: blur(8px); }
    .modal { width: min(560px, 96vw); display: flex; flex-direction: column; overflow: hidden;
      color: var(--text-primary); background: var(--bg-surface);
      border: 1px solid color-mix(in srgb, var(--accent-primary, #06b6d4) 34%, var(--border-default));
      border-radius: 16px; box-shadow: 0 28px 90px rgba(0,0,0,0.55); }
    .modal-head { padding: 20px 22px 12px; }
    .eyebrow { margin-bottom: 3px; color: var(--accent-primary, #06b6d4); font-size: 0.68rem;
      font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; }
    h2 { margin: 0; overflow: hidden; font-size: 1.16rem; font-weight: 680; letter-spacing: -0.02em;
      text-overflow: ellipsis; white-space: nowrap; }
    .modal-body { padding: 4px 22px 20px; }
    .route { margin-bottom: 16px; padding: 11px 13px; display: flex; align-items: center; gap: 11px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #06b6d4) 28%, var(--border-default));
      border-radius: 10px; background: color-mix(in srgb, var(--accent-primary, #06b6d4) 7%, var(--bg-elevated)); }
    .route-icon { font-size: 1.22rem; }
    .route-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
    .route-copy strong { overflow: hidden; font-size: 0.86rem; text-overflow: ellipsis; white-space: nowrap; }
    .route-kicker { color: var(--text-secondary); font-size: 0.68rem; }
    .bar { height: 8px; overflow: hidden; border-radius: 99px; background: var(--bg-elevated); }
    .fill { height: 100%; border-radius: 99px; background: var(--accent-primary, #06b6d4);
      transition: width 0.25s ease-out; }
    .bar.waiting .fill { opacity: 0.35; }
    .counts { margin-top: 7px; display: flex; justify-content: space-between; gap: 10px;
      color: var(--text-secondary); font-size: 0.74rem; }
    .pct { color: var(--text-primary); font-variant-numeric: tabular-nums; font-weight: 650; }
    .line { margin-top: 12px; padding: 8px 10px; overflow: hidden; border-radius: 7px;
      color: var(--text-secondary); background: var(--bg-elevated); font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
    .note { margin-top: 12px; color: var(--text-secondary); font-size: 0.74rem; line-height: 1.45; }
    .note.patience { color: var(--text-tertiary); }
    .modal-actions { display: flex; justify-content: flex-end; gap: 9px;
      padding: 14px 22px calc(14px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-default); background: var(--bg-surface); }
    .counts.eta { margin-top: 4px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .stop-btn, .bg-btn, .queue-btn { padding: 9px 15px; border-radius: 8px; cursor: pointer; font-size: 0.78rem; font-weight: 650; }
    .queue-btn { color: var(--text-primary); border: 1px solid var(--border-default); background: var(--bg-elevated); }
    .stop-btn { color: #ef4444; border: 1px solid color-mix(in srgb, #ef4444 40%, var(--border-default));
      background: var(--bg-elevated); }
    .stop-btn:disabled { opacity: 0.48; cursor: default; }
    .bg-btn { color: #fff; border: 1px solid var(--accent-primary, #06b6d4); background: var(--accent-primary, #06b6d4); }
    @media (max-width: 620px) {
      .backdrop { padding: 10px; align-items: end; }
      .modal { width: 100%; border-radius: 16px 16px 8px 8px; }
    }
    @media (prefers-reduced-motion: no-preference) {
      .modal { animation: modal-in 0.16s ease-out; }
      @keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(0.99); } }
    }
  `],
})
export class StudioConvertModalComponent {
  private readonly conversions = inject(BookConversionService);

  readonly projectDir = input.required<string>();
  /** Closing this window leaves the run going. It is not a cancel. */
  readonly close = output<void>();

  readonly run = computed<ConversionRun | null>(() => this.conversions.runFor(this.projectDir()));

  readonly percent = computed(() => {
    const r = this.run();
    if (!r || r.total <= 0) return 0;
    return Math.min(100, Math.round((r.done / r.total) * 100));
  });

  /**
   * Escape backgrounds the run; it does not stop it.
   *
   * The reflex that closes a dialog must never be the one that throws away an
   * hour of GPU. Stopping is a button, pressed on purpose.
   */
  @HostListener('document:keydown.escape')
  onEscape(): void { this.close.emit(); }

  stop(): void { void this.conversions.stop(this.projectDir()); }

  /** Start the prepared conversion here, in this window. */
  begin(): void { void this.conversions.begin(this.projectDir()); }

  /**
   * Hand it to the Queue tab and close.
   *
   * Owen, 2026-08-08: "if the user hits run in background it should add it to the
   * queue tab instead of minimizing." Before it has started this queues the work;
   * once running it moves where the run is WATCHED without touching the run.
   */
  addToQueue(): void {
    void this.conversions.sendToQueue(this.projectDir());
    this.close.emit();
  }

  /** Throw away a conversion that was never started. Nothing is running. */
  dismiss(): void {
    this.conversions.discard(this.projectDir());
    this.close.emit();
  }

  /**
   * `4.8s/page · 22m 10s left`, measured — never the guess this window used to
   * print ("about eighteen seconds a page"), which was an M1 Ultra figure shown
   * to a machine reading four times faster through vLLM.
   *
   * Recomputed on the shared one-second tick so the ETA counts DOWN between page
   * completions instead of standing still; the rate itself is only re-measured
   * when a page lands. Null until the first page, because there is nothing to
   * say and "calculating…" is not a measurement.
   */
  readonly rateLine = computed(() => {
    const r = this.run();
    if (!r || r.phase !== 'running') return null;
    const now = this.conversions.tick();
    const parts = [
      formatPageRate(r.rate ?? null),
      formatEta(conversionEtaSeconds(r.rate ?? null, now)),
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return parts.length === 2 ? `${parts[0]} · ${parts[1]} left` : parts[0];
  });
}
