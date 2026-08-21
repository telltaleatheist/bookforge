import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { CaptureService } from '../../core/capture.service';

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
  template: `
    @if (captures.intakeProgress(); as run) {
      <!--
        No click handler on the scrim. Every other dialog's scrim dismisses it;
        this one has nothing to dismiss to, and a scrim that swallows clicks
        silently is the same complaint that made this component necessary.
      -->
      <div class="scrim"></div>

      <div class="card" role="dialog" aria-modal="true" aria-label="Reading photographs">
        <header class="head">
          <span class="title">Reading photographs</span>
        </header>

        <div class="body">
          <p class="count">{{ run.done }} of {{ run.total }}</p>
          <!--
            The filename holds its line whether or not there is one: the closing
            push carries an empty file name while the recipe is written, and a
            disappearing line would make the card jump at the very end.
          -->
          <p class="file">{{ run.file.length > 0 ? run.file : 'Writing the recipe…' }}</p>

          <div class="track" role="progressbar"
               [attr.aria-valuenow]="run.done"
               [attr.aria-valuemin]="0"
               [attr.aria-valuemax]="run.total">
            <div class="fill" [style.width.%]="percent()"></div>
          </div>

          <p class="lead">
            Each photograph is decoded once and kept as an upright copy. The
            window may not answer while one is being read.
          </p>
        </div>
      </div>
    }
  `,
  styles: [`
    /*
     * CENTERED ON THE WINDOW, both axes (Owen, Wave 21b). It used to hang 64px
     * from the top, which is where a toast lives rather than where a modal does
     * -- and this one holds the window for a minute while twenty-seven
     * photographs are decoded, so it is the most-looked-at surface in the
     * feature and it sat off-centre under the eye the whole time.
     *
     * A grid rather than a flex column because the SCRIM is a sibling: it is
     * absolutely positioned, so it leaves the flow entirely and place-items
     * has exactly one child to centre. Nothing here needs to know the card's
     * height, which is the property that made margin-64px-auto-0 wrong in
     * the first place -- a fixed offset is a guess about a size.
     */
    :host {
      position: fixed; inset: 0; z-index: 1250;
      display: grid; place-items: center;
      pointer-events: none;
    }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
    }

    .card {
      position: relative;
      pointer-events: auto;
      width: min(420px, calc(100vw - 48px));
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
    }

    .head { padding: 16px 20px 8px; }
    .title { font-family: var(--font-display); font-size: 15px; font-weight: 600; }

    .body { padding: 0 20px 18px; }
    .count { margin: 0 0 2px; font-size: 13px; color: var(--text-primary); }
    /* Fixed height and a monospace face so a long filename replacing a short one
       does not resize the card under somebody's eyes twenty-seven times. */
    .file {
      margin: 0 0 12px;
      height: 16px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .track {
      height: 6px;
      border-radius: 3px;
      background: var(--bg-input);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--accent-strong);
      transition: width 160ms cubic-bezier(0, 0, 0.2, 1);
    }

    .lead { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
  `],
})
export class CaptureProgressComponent {
  protected readonly captures = inject(CaptureService);

  /** Guarded against a zero total, which would be a division rather than a bar. */
  protected readonly percent = computed(() => {
    const run = this.captures.intakeProgress();
    if (run === null || run.total === 0) return 0;
    return Math.round((run.done / run.total) * 100);
  });
}
