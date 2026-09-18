/**
 * doctor-pane — what Foundry needs on this computer, and the buttons that get it.
 *
 * ── THERE IS NO LOCAL AI HERE, AND THERE IS NOT MEANT TO BE ───────────────
 *
 * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
 * there sohuldnt be a local system. foundry does all ai work through
 * crucible."* And, on what this page is for: *"the doctor logic in bookforge
 * repairs broken or missing environment/dependencies."*
 *
 * Those two sentences decide the whole contents. A dependency this machine
 * needs in order to run at all belongs here. A model, a tier, an inference
 * server — anything that would let Foundry do AI work WITHOUT a Crucible —
 * does not exist any more, so it cannot be offered, measured, or chosen
 * between.
 *
 * ── AND THE LINE THAT RULING IS DRAWN ON, GIVEN THE SAME EVENING ──────────
 *
 * Two hours later, working out where the analysis ranker belongs: *"crucible is
 * a gpu orchestrator that does steps atomically, which sometimes leads to cpu
 * steps going to the other system, but if it's fully a cpu step, it can stay
 * local."*
 *
 * So the rule is not *nothing runs here*. It is **THE CARD IS SOMEBODY ELSE'S
 * AND THE PROCESSOR IS OURS.** Anything wanting a GPU goes to Crucible, without
 * exception and with no local fallback to reach for — that is what the previous
 * paragraph deleted. A step that is fully CPU and cheap stays on this machine,
 * and is then a DEPENDENCY, which is precisely what this page is for.
 *
 * That line is what admits the two things left below, and it is why they are
 * not a compromise: neither of them touches an accelerator.
 *
 * WHAT WENT, 2026-09-17, and it was most of the page:
 *
 *   * **The tier cards.** `endpoint`, `wsl-vllm`, `mlx`, `native` — four
 *     backends this machine might read pages with, measured and ranked. They
 *     described a local inference stack, which is the thing Owen says should
 *     not exist. Three of the four were permanently red on his machine and the
 *     fourth was red because it pointed at a port nothing has served since the
 *     vLLM launcher was retired.
 *   * **"Which tier reads a page"** — the `settings.json` form holding
 *     `backend.mode`, `backend.endpointUrl` and `backend.python`. It was moved
 *     here the same day, from the opposite column, on the argument that a
 *     control belongs beside the measurement it chooses between. Correct about
 *     the layout and overtaken by the ruling: the choice itself is gone, so the
 *     right place for it is nowhere.
 *   * **The page reader card.** The one backend this app installed and ran
 *     itself — a llama.cpp build and two dots.ocr files. It is exactly a local
 *     system, and `electron/act-gates.ts` now refuses a reading with no engine
 *     rather than falling back to it.
 *
 * WHAT STAYS, AND WHY IT IS NOT THE SAME KIND OF THING:
 *
 *   * **The rasteriser.** PyMuPDF turns a PDF page into an image, and that
 *     happens on this machine before any picture is sent anywhere — there is no
 *     Crucible route for it and there should not be, because it is not AI work.
 *     A machine without it cannot convert a book at all, which is the
 *     definition of a dependency.
 *   * **The environments.** The prebuilt Pythons, with the button that fetches
 *     a missing one. This is the repair half Owen names in BookForge, and it is
 *     the only half of this page that can act.
 *
 * ── THE ENGINE LINE STAYS TOO ─────────────────────────────────────────────
 *
 * Which `foundry` binary this window is driving, and its version. Not a
 * dependency a person installs, but the first thing anybody diagnosing this app
 * needs to know, and the one fact that makes a bug report answerable.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { DoctorReport, EngineInfo } from '@shared/types';

import { api } from '../../core/foundry';
import { EnvCardComponent } from './env-card.component';

@Component({
  selector: 'app-doctor-pane',
  imports: [EnvCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane-head">
      @if (engine(); as info) {
        <div class="engine-line">
          <span class="mono">{{ info.command }} {{ info.args.join(' ') }}</span>
          <span class="muted">{{ info.version ?? 'version unknown' }} · {{ info.source }}</span>
        </div>
      }
      <button class="ghost" [disabled]="probing()" (click)="probe()">
        {{ probing() ? 'Probing…' : 'Re-probe' }}
      </button>
    </div>

    @if (report(); as r) {
      <!--
        THE ONE MEASUREMENT LEFT, and it is a dependency rather than a backend:
        every conversion draws the book locally before anything reads it, so a
        machine without PyMuPDF cannot convert at all. The tier cards that used
        to sit under this went with the local inference stack they described.
      -->
      <div class="card" [attr.data-ok]="r.rasteriser.available">
        <div class="card-head">
          <span class="dot" [attr.data-ok]="r.rasteriser.available"></span>
          <span class="card-title">Rasteriser (PyMuPDF)</span>
        </div>
        <p class="detail">{{ r.rasteriser.detail }}</p>
        @if (r.rasteriser.python) {
          <p class="mono small">{{ r.rasteriser.python }}</p>
        }
        @if (!r.rasteriser.available) {
          <p class="detail">
            Every conversion renders the pages on this computer before anything reads them, so
            nothing can be converted until this is present. Installing the environment below
            provides it.
          </p>
        }
      </div>
    } @else if (doctorProblem(); as reason) {
      <div class="card">
        <div class="card-head">
          <span class="dot" data-ok="false"></span>
          <span class="card-title">No report</span>
        </div>
        <pre class="detail pre">{{ reason }}</pre>
      </div>
    } @else {
      <p class="muted">Asking the engine what this machine has…</p>
    }

    <!-- The prebuilt Pythons, and the button that fetches a missing one. The
         repair half: this is the only thing on the page that can act. -->
    <app-env-card (changed)="probe()" />

    <!--
      SAID PRECISELY, because the first draft of this line claimed that every
      act meeting a model runs on a Crucible server, and that is not true: the
      analysis ranker is a small CPU classifier and stays here under Owen's rule
      about which work belongs where. A page whose closing sentence overstates
      is a page teaching somebody the wrong thing about their own machine.
    -->
    <p class="muted">
      Nothing on this page needs a graphics card. Every act that needs one — reading a scanned
      page, cleaning up text, translating, simplifying, and the judging half of analysis — runs
      on a Crucible server, and Foundry keeps no local copy of any of it to be missing. What this
      computer does for itself is draw the pages, and for analysis the first pass that scores
      every sentence. Both run on the processor, and both are environments above.
    </p>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; }

    .pane-head { display: flex; align-items: flex-start; gap: 12px; }
    .engine-line { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }

    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); flex-shrink: 0; }
    .dot[data-ok="true"] { background: var(--ok); }

    .detail { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 4px 0 0; }
    .muted { color: var(--text-tertiary); font-size: 12px; margin: 0; }

    .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-md);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class DoctorPaneComponent {
  protected readonly report = signal<DoctorReport | null>(null);
  protected readonly doctorProblem = signal<string | null>(null);
  protected readonly probing = signal(false);
  protected readonly engine = signal<EngineInfo | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) {
      this.doctorProblem.set('This page is running outside Electron, so there is no engine to ask.');
      return;
    }
    this.engine.set(await api.engineInfo());
    await this.probe();
  }

  /**
   * One probe, with NO endpoint argument.
   *
   * It used to pass the URL that was on screen rather than the saved one, so
   * that testing an endpoint did not require writing to the engine's settings
   * file first. There is no endpoint on screen any more and no tier for one to
   * belong to, so the engine is asked about this machine and nothing else. The
   * report still carries tiers; this page draws only the rasteriser out of it,
   * because the rest describes a local inference stack that no longer runs.
   */
  protected async probe(): Promise<void> {
    if (!api) return;
    this.probing.set(true);
    try {
      const result = await api.doctor();
      if (result.ok) {
        this.report.set(result.report);
        this.doctorProblem.set(null);
      } else {
        this.report.set(null);
        this.doctorProblem.set(result.reason);
      }
    } finally {
      this.probing.set(false);
    }
  }
}
