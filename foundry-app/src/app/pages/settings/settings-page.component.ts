import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { hosted } from '../../core/foundry';
import { UiService } from '../../core/ui.service';
import { AiPaneComponent } from './ai-pane.component';
import { DoctorPaneComponent } from './doctor-pane.component';
import { LibraryCardComponent } from './library-card.component';
import { ServersCardComponent } from './servers-card.component';
import { SetupCardComponent } from './setup-card.component';

/**
 * Settings — four errands, one per section.
 *
 * ── WHAT THIS WAS, AND WHY IT IS A TREE NOW ───────────────────────────────
 *
 * One page called "Backend", two columns, eleven cards in a single scroll: the
 * doctor's measurement down the left, and down the right the settings.json
 * form, the library folder, first-run setup, the Crucible registry, the
 * engine's routes, the engine's models, the cloud keys, the Python
 * environments, the page reader and the models on the disk. Every card's own
 * comment argued convincingly for its neighbour — and eleven such arguments
 * compose a column, not a page. Nothing on it was wrong; there was just no
 * answer to *where do I go for X* except "scroll".
 *
 * Owen, 2026-09-17, sending BookForge's settings screen over: *"lets organize
 * the foundry settings like this as well. teh user adds crucible servers and
 * they configure the crucible server for foundry's uses in foundry settings
 * directly."*
 *
 * BookForge got there first and its own comments carry the rule that produced
 * it, which is the rule followed here: **a section is shaped by what a person
 * came looking for, not by which component was written first.** BookForge went
 * from fifteen sections to four by that rule — its author's note on the merge
 * is *"four sidebar entries for that was a tree shaped by which component was
 * written first rather than by what a person came looking for"* — and Foundry
 * arrives at the same four from the other direction, splitting one scroll
 * rather than collapsing fifteen tabs.
 *
 * THE TWO APPS MATCHING IS ITSELF THE FEATURE, not a coincidence of taste. They
 * are two windows onto one engine — the same registry, the same
 * `/v1/settings` document, often the same machine — so somebody who learns
 * where the model picker lives in one has learned where it lives in the other.
 *
 * ── THE FOUR, AND WHAT DECIDED EACH ───────────────────────────────────────
 *
 *   * **General** — this machine's own facts: where books go, what setup
 *     skipped, and what weights are on the disk. Foundry's, not the engine's.
 *   * **Crucible Servers** — which engines exist and in what order work tries
 *     them. Owen: *"the user adds crucible servers"*, and this is where.
 *   * **AI** — and *"they configure the crucible server for foundry's uses"*
 *     here. One row per job, writing straight into that server's settings.
 *   * **Doctor** — is anything missing on this computer, and the buttons that
 *     fetch it. It absorbed the measurement column and the tier form that
 *     chooses between the things that column measures, which had been four
 *     cards and one column apart.
 *
 * ── AND GUIDED SETUP IS A BUTTON, BECAUSE IT IS AN ACTION ─────────────────
 *
 * It was a card on a page of settings, which is BookForge's exact diagnosis of
 * its own: a thing you PRESS filed among things you SET. It sits under the
 * section list because it reconfigures every section at once and belongs to
 * none of them. `setup-card` keeps only the half that is a FACT — which steps
 * were skipped — because two buttons for one action is the duplication this
 * whole reorganisation exists to remove.
 */
interface SettingsSection {
  readonly id: 'general' | 'crucible' | 'ai' | 'doctor';
  readonly name: string;
  readonly icon: string;
  /** The one line under the heading. What this section is FOR, not what it has. */
  readonly description: string;
}

const SECTIONS: readonly SettingsSection[] = [
  {
    id: 'general',
    name: 'General',
    icon: '📚',
    description: 'This machine: where its books go, and what it keeps on the disk',
  },
  {
    id: 'crucible',
    name: 'Crucible Servers',
    icon: '🛰️',
    description: 'Inference servers the queue may use: this machine’s, and any you add',
  },
  {
    id: 'ai',
    name: 'AI',
    icon: '🤖',
    description: 'Which Crucible model does the reading and writing',
  },
  {
    id: 'doctor',
    name: 'Doctor',
    icon: '🩺',
    description: 'What Foundry needs on this computer, and the buttons that get it',
  },
];

@Component({
  selector: 'app-settings-page',
  imports: [
    AiPaneComponent, DoctorPaneComponent, LibraryCardComponent,
    ServersCardComponent, SetupCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <nav class="rail">
        <h1>Settings</h1>
        <div class="section-list">
          @for (section of sections; track section.id) {
            <button class="section-item" type="button"
                    [class.active]="selected() === section.id"
                    (click)="selected.set(section.id)">
              <span class="section-icon">{{ section.icon }}</span>
              <span class="section-name">{{ section.name }}</span>
            </button>
          }
        </div>

        <!--
          SET APART FROM THE LIST BECAUSE IT ACTS RATHER THAN NAVIGATES, and
          hidden inside a host for setup-card's own reason: the wizard's first
          step is the library, which a hosted window does not own, and its later
          steps reconfigure an engine the host runs. UiService.openSetup refuses
          there as well, so this is a hidden door and not a decorated one.
        -->
        @if (!hosted()) {
          <button class="section-item guided-setup" type="button" (click)="openSetup()">
            <span class="section-icon">🧭</span>
            <span class="section-name">Run guided setup…</span>
          </button>
        }
      </nav>

      <section class="pane">
        <!--
          THE SCROLLER FILLS THE WINDOW AND THE CONTENT IS CENTRED INSIDE IT.
          It used to be one element doing both jobs — max-width 860 AND
          overflow-y — which put the scrollbar at the right edge of the CONTENT,
          860px into a 2000px window, with dead space beyond it. A scrollbar
          belongs at the edge of the thing it scrolls, and the thing it scrolls
          is the window. Owen, seeing it: "the scrollbar is in the middle of the
          window."
        -->
        <div class="pane-inner">
        @if (current(); as section) {
          <header class="pane-head">
            <h2>{{ section.name }}</h2>
            <p class="pane-detail">{{ section.description }}</p>
          </header>

          @switch (section.id) {
            @case ('general') {
              <!--
                Where the books go, FIRST, because it is the one setting in this
                app that is about the user's own files rather than about which
                Python reads a page. Hosted, it is the HOST's fact about its own
                data — main refuses library:set anyway — and a control that can
                only refuse is not a control, so the card goes.
              -->
              @if (!hosted()) {
                <app-library-card />
              }

              <!-- What the first-run walk-through skipped, which is a fact a
                   person can act on. The button that re-runs it is under the
                   section list, where actions live. -->
              <app-setup-card />

            }

            @case ('crucible') {
              <!--
                WHERE WORK CAN GO — the Crucible servers this machine knows
                about, in the order it will try them (docs/SLOTS.md). Drawn
                hosted as well, read-only, because a hosted window still has
                slots — the host's — and a card that vanished would leave the
                queue's picker naming machines nothing explains.
              -->
              <app-servers-card />
            }

            @case ('ai') {
              <!--
                AND WHAT EACH OF THOSE SERVERS HAS BEEN TOLD TO DO WITH THE WORK
                (crucible docs/PHASE15-HOST.md §3.7, §5.2). Nothing on it is
                stored here — Owen's ruling is that the engine is the single
                source of truth for these settings, so every control is a
                request to it and its answer is what redraws. Not hidden hosted,
                because §5.3 says the hosted pane draws the HOST's registry and
                shows the same engine.
              -->
              <app-ai-pane />
            }

            @case ('doctor') {
              <app-doctor-pane />
            }
          }
        }
        </div>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .page { display: grid; grid-template-columns: 200px minmax(0, 1fr); height: 100%; }

    /* No divider rule: the rail is set apart by its own width and the pane's
       indentation, and a line down the middle of a wide window reads as a seam.
       Owen: "dont give it a border". */
    .rail {
      display: flex; flex-direction: column; gap: 4px;
      padding: 16px 8px;
      overflow-y: auto;
    }
    .rail h1 { margin: 0 0 10px 10px; font-size: 18px; font-weight: 600; }
    .section-list { display: flex; flex-direction: column; gap: 2px; }

    .section-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 7px 10px;
      font: inherit; font-size: 13px; text-align: left;
      background: transparent; color: var(--text-secondary);
      border: none; border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .section-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    /*
      ACTIVE IS A BACKGROUND AND A WEIGHT, AND THE TEXT COLOUR ONLY GOES UP.
      bookforge-02 shipped the sibling of this control with the accent used as a
      fill behind the ordinary foreground and Owen could not read it. Nothing
      here puts text on the accent; the accent is a bar at the edge.
    */
    .section-item.active {
      background: var(--bg-sunken); color: var(--text-primary); font-weight: 600;
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .section-icon { font-size: 14px; line-height: 1; }
    .section-name { min-width: 0; }

    /* Set apart from the section list: it acts rather than navigates. */
    .section-item.guided-setup {
      margin-top: 10px; padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
      border-radius: 0;
      opacity: 0.8;
    }
    .section-item.guided-setup:hover { opacity: 1; }

    /* The scroller. Full width, so its scrollbar is the window's right edge. */
    .pane { overflow-y: auto; padding: 20px 24px 60px; }
    /* The content. Centred, and it re-centres as the window resizes because the
       margin is auto rather than a computed offset. */
    .pane-inner {
      display: flex; flex-direction: column; gap: 10px;
      max-width: 860px; margin: 0 auto;
    }
    .pane-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
    .pane-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .pane-detail { margin: 0; font-size: 12px; color: var(--text-tertiary); }

    @media (max-width: 720px) {
      .page { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .rail { flex-direction: row; align-items: center; overflow-x: auto; }
      .rail h1 { display: none; }
      .section-list { flex-direction: row; }
      .section-item.guided-setup { margin-top: 0; padding-top: 7px; border-top: none; }
    }
  `],
})
export class SettingsPageComponent {
  protected readonly hosted = hosted;
  protected readonly sections = SECTIONS;

  private readonly ui = inject(UiService);

  /**
   * WHICH SECTION IS OPEN — and it opens on General.
   *
   * Not on the section somebody was last in. A settings screen that restores a
   * position is guessing that the errand is the same one as last time, and the
   * common case here is the opposite: a person comes to Settings because
   * something new needs attention. General is the cheapest place to be wrong
   * about — it holds no engine controls and nothing on it is in flight.
   */
  protected readonly selected = signal<SettingsSection['id']>('general');

  protected readonly current = computed(
    () => this.sections.find((section) => section.id === this.selected()) ?? null);

  protected openSetup(): void {
    this.ui.openSetup();
  }
}
