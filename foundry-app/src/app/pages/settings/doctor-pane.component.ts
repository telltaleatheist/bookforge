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
 * ── AND WHAT WENT, 2026-11-04: BOTH OF THOSE ──────────────────────────────
 *
 * Owen: Foundry always ships with Crucible, so every model call goes to Crucible
 * and Foundry has no Python. The rasteriser is MuPDF inside the engine now
 * (`vlm/raster.ts`, the `mupdf` package) — it travels with the app and cannot
 * be missing, so there is nothing to measure — and the environments it was
 * installed from went with it, card, catalog, installer and the startup
 * provisioner alike. Folders an earlier version downloaded are left on disk for
 * the user to delete (`retireSettingsKeys`, node/settings.ts, names them once).
 * The engine still answers `doctor`; this page no longer draws any of it.
 *
 * ── THE ENGINE LINE STAYS ─────────────────────────────────────────────────
 *
 * Which `foundry` binary this window is driving, and its version. Not a
 * dependency a person installs, but the first thing anybody diagnosing this app
 * needs to know, and the one fact that makes a bug report answerable.
 */
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import type { EngineInfo } from '@owen/foundry-core/shared/types';

import { api } from '../../core/foundry';

@Component({
  selector: 'app-doctor-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane-head">
      @if (engine(); as info) {
        <div class="engine-line">
          <span class="mono">{{ info.command }} {{ info.args.join(' ') }}</span>
          <span class="muted">{{ info.version ?? 'version unknown' }} · {{ info.source }}</span>
        </div>
      }
    </div>

    <!--
      SAID PRECISELY, because the first draft of this line claimed that every
      act meeting a model runs on a Crucible server, and that is not true: the
      analysis ranker is a small CPU classifier and stays here under Owen's rule
      about which work belongs where. A page whose closing sentence overstates
      is a page teaching somebody the wrong thing about their own machine.
    -->
    <p class="muted">
      Nothing on this page needs a graphics card. Every act that needs one — reading a scanned
      page, translating, simplifying, and the judging half of analysis — runs
      on a Crucible server, and Foundry keeps no local copy of any of it to be missing. What this
      computer does for itself is draw the pages, and for analysis the first pass that scores
      every sentence. Both run on the processor, inside the app.
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
  protected readonly engine = signal<EngineInfo | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!api) return;
    this.engine.set(await api.engineInfo());
  }
}
