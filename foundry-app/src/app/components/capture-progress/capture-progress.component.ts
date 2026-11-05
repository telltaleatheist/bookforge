import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { CaptureService } from '../../core/capture.service';
import { PdfPagesService } from '../../core/pdf-pages.service';

/**
 * READING PHOTOGRAPHS — the minute the app cannot answer, made visible.
 *
 * ── Why this is a modal and not a strip ─────────────────────────────────────
 *
 * Owen's ask was literally "it should pop up a progress modal", and the reason
 * it is the right shape is harsher than politeness: an intake blocks MAIN for
 * the better part of a minute, so the window really is unavailable — it cannot
 * be moved, and clicking anything does nothing until the current photograph is
 * decoded. A strip in the corner would say "something is happening" while the
 * rest of the app lied about being usable. A card over a dimmed window says the
 * true thing: come back in a minute.
 *
 * P1 has taken the block from one unbroken minute down to about 1.4 s per
 * photograph, which is what makes this drawable at all — a progress line that
 * cannot repaint is a nicer-looking freeze.
 *
 * ── NO CANCEL, and that is deliberate for v1 ────────────────────────────────
 *
 * Deferred by name in the doc. A cancel that cannot interrupt a wasm decode
 * would stop between photographs at best, which means a button that appears to
 * do nothing for over a second — and a project half full of originals with a
 * recipe that does not list them. Half an intake is a worse thing to own than a
 * finished one somebody did not want.
 *
 * ── IT DRAWS TWO PASSES NOW, AND THE SECOND ONE CAN BE STOPPED ─────────────
 *
 * A dropped PDF is rasterized page by page before any of it reaches intake
 * (`PdfPagesService`), which is the same shape of wait for the same person and
 * belongs on the same card rather than in a second one invented beside it. The
 * numbers, the bar and the filename line are identical; two things differ, and
 * both are true rather than decorative.
 *
 * THE LEAD SENTENCE, because the two waits are not the same wait. An intake
 * blocks MAIN and the window really cannot answer; a rasterizing pass runs in
 * THIS process with the UI thread free between pages, so a card that told
 * somebody the window may not answer would be a lie in the more alarming
 * direction.
 *
 * AND A STOP BUTTON, WHICH THE INTAKE DELIBERATELY HAS NOT GOT. The intake's
 * refusal is argued above and stands: a wasm decode cannot be interrupted. A
 * page is a canvas render taking a fraction of a second, so stopping is
 * immediate in the only sense a person can perceive — and a 600-page scan
 * dropped by accident is minutes of work with, until now, nothing to do but
 * watch it. Nothing has been intaken while this runs, so what stopping leaves
 * behind is a staging directory that deletes itself and a library untouched.
 *
 * BOTH ARE NEVER ON SCREEN AT ONCE. The explosion finishes before the intake it
 * feeds is asked for (`CaptureService.intake`), so these two `@if`s are a
 * sequence and not a stack — which is why they may share a z-index and a scrim
 * without either having an opinion about the other.
 *
 * ── `done` SITS ONE BEHIND `file`, BY CONTRACT ──────────────────────────────
 *
 * `file` names the photograph IN HAND rather than the one just finished
 * (docs/CAPTURE.md, and P1's own reason: a line naming the finished one names
 * what the person has already waited for). So "3 of 27" beside IMG_0214 means
 * three are done and 0214 is being read now. Nothing here re-derives that; the
 * arithmetic was settled in the payload precisely so this component has none.
 */
@Component({
  selector: 'app-capture-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-progress.component.html',
  styleUrl: './capture-progress.component.scss',
})
export class CaptureProgressComponent {
  protected readonly captures = inject(CaptureService);
  protected readonly pdfPages = inject(PdfPagesService);

  /** Guarded against a zero total, which would be a division rather than a bar. */
  protected readonly percent = computed(() => {
    const run = this.captures.intakeProgress();
    if (run === null || run.total === 0) return 0;
    return Math.round((run.done / run.total) * 100);
  });

  /** The same arithmetic over the other pass. Two signals, one guard each. */
  protected readonly pdfPercent = computed(() => {
    const run = this.pdfPages.progress();
    if (run === null || run.total === 0) return 0;
    return Math.round((run.done / run.total) * 100);
  });
}
