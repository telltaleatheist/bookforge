/**
 * run-progress — one run, drawn inside the dialog that started it.
 *
 * ── Why this is a component and not five copies of a bar ──────────────────
 *
 * Owen, 2026-09-17: *"if they hit start, progress shows in the modal live."*
 * Five dialogs start work — read, clean, translate, simplify, analyse — and a
 * progress bar written five times is five places for the phase names to drift
 * apart. The words for what a run is DOING live here, once, and they are keyed
 * on the engine's own `phase` rather than on which dialog mounted this: a
 * translate job that renders before it translates reports `render` and must not
 * be described as translating while it does.
 *
 * ── NOT-YET-KNOWN IS A STATE AND IS DRAWN AS ONE ─────────────────────────
 *
 * `JobProgress` is the engine's own fraction, and this never invents one: a bar
 * that drifted forward on its own would be fabricating the single number the
 * person is watching.
 *
 * It used to draw an EMPTY track while waiting for the first count, which is
 * honest and looks broken — a reading spends its opening stretch starting an
 * engine and drawing pages before any count exists. Owen, watching one: *"progres
 * bar doesnt seem to be working?"* It was; it had nothing to say yet, and those
 * are different things that should not look the same. So the track sweeps while
 * it waits, which claims movement without claiming a position, and the moment a
 * real fraction arrives the sweep stops and the fill takes over.
 *
 * AND THE ENGINE'S LOG LINE IS NOT SHOWN AT ALL — see {@link says}. That was the
 * other half of what Owen was looking at: raw stderr, in a dialog, under a bar.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { Job } from '@shared/types';

@Component({
  selector: 'app-run-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="run">
      <!--
        INDETERMINATE UNTIL THERE IS A FRACTION, rather than a bar sitting at
        zero. A reading spends its first stretch starting an engine and drawing
        pages before the engine emits its first count, and an empty track for
        that long reads as broken -- Owen: "progres bar doesnt seem to be
        working?". It was working; it had nothing to say yet, which is a
        different thing and should look different.
      -->
      <div class="bar" [attr.data-state]="job().state" [class.waiting]="waiting()">
        <div class="fill" [style.width.%]="percent()"></div>
      </div>
      <p class="says">{{ says() }}</p>
      @if (job().error; as reason) { <p class="problem">{{ reason }}</p> }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .run { display: flex; flex-direction: column; gap: 6px; }
    .bar { height: 4px; border-radius: 999px; background: var(--bg-sunken); overflow: hidden; }
    .fill {
      height: 100%; width: 0; background: var(--accent);
      transition: width 200ms cubic-bezier(0, 0, 0.2, 1);
    }
    .bar[data-state="failed"] .fill, .bar[data-state="cancelled"] .fill { background: var(--warn); }
    /* A moving stripe, not a fake percentage: it says "alive" without claiming
       to know how far along anything is. */
    .bar.waiting {
      background-image: linear-gradient(90deg,
        var(--bg-sunken) 0%, var(--accent-soft) 50%, var(--bg-sunken) 100%);
      background-size: 200% 100%;
      animation: run-progress-sweep 1.4s linear infinite;
    }
    @keyframes run-progress-sweep {
      from { background-position: 200% 0; }
      to { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .bar.waiting { animation: none; background-image: none; }
    }
    .says { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }
  `],
})
export class RunProgressComponent {
  readonly job = input.required<Job>();

  /** What this run is called while it is happening, for the idle states. */
  readonly verb = input('Working');

  /** No fraction yet, and still going: the bar animates rather than sitting. */
  protected readonly waiting = computed(() => {
    const job = this.job();
    if (job.state !== 'running' && job.state !== 'queued') return false;
    const progress = job.progress;
    return progress === null || progress.total <= 0;
  });

  protected readonly percent = computed(() => {
    const progress = this.job().progress;
    if (progress === null || progress.total <= 0) return 0;
    return Math.min(100, Math.round((progress.page / progress.total) * 100));
  });

  /**
   * THE RUN IN ONE SENTENCE.
   *
   * The states are said in the words of what happened rather than in the
   * queue's vocabulary: `held` and `queued` are real distinctions to the shelf
   * and mean "not started yet" and "not started yet" to somebody watching a
   * dialog — but they are answered separately anyway, because the reasons
   * differ and the second one is the one that might last.
   *
   * THE PHASE IS THE ENGINE'S, and it is what makes the counted line honest.
   * `translate` counts BLOCKS rather than pages; an analysis ranks every
   * sentence and then verifies the survivors, which are two unrelated totals in
   * one run (docs/ANALYSIS.md §2). A line that said "page" for all of them would
   * be naming the wrong quantity three times out of six.
   */
  protected readonly says = computed(() => {
    const job = this.job();
    if (job.error) return 'It stopped.';
    switch (job.state) {
      case 'held': return 'Waiting to be released.';
      case 'queued': return 'Waiting for an engine to be free.';
      case 'cancelled': return 'Stopped.';
      case 'failed': return 'It stopped.';
      case 'done': return 'Finished.';
      case 'running': break;
    }
    const progress = job.progress;
    /*
     * THE ENGINE'S LOG LINE IS NOT SHOWN, and this is where it used to be.
     *
     * `Job.message` is "the last thing the engine said that was NOT a count" --
     * raw stderr, meant for the shelf's detail row and a bug report. It was the
     * fallback here, so a modal with no fraction yet printed installer-style
     * output at somebody who pressed Start on a book. Owen: "i dont think the
     * user needs the logs."
     *
     * It is not replaced by a scrolling box either. The queue row still carries
     * it for anybody who wants it; a dialog whose job is "is this moving" does
     * not become better by adding a console to it.
     */
    if (progress === null) return `${this.verb()}…`;
    const { page, total, phase } = progress;
    switch (phase) {
      case 'render': return `Drawing page ${page} of ${total}.`;
      case 'read': return `Reading page ${page} of ${total}.`;
      case 'translate': return `Translating paragraph ${page} of ${total}.`;
      case 'clean': return `Cleaning paragraph ${page} of ${total}.`;
      // The question before a cleanup: which paragraphs need it at all.
      case 'triage': return `Checking paragraph ${page} of ${total}.`;
      case 'rank': return `Scoring sentence ${page} of ${total}.`;
      case 'verify': return `Checking passage ${page} of ${total}.`;
      /*
       * A PHASE THIS BUILD HAS NOT HEARD OF IS COUNTED, NOT SWALLOWED. The
       * engine is released separately and may grow one; a bar that fell silent
       * on an unknown word would look like a run that had stopped reporting.
       * The count is still true, so the count is what it says.
       */
      default: return `${page} of ${total}.`;
    }
  });
}
