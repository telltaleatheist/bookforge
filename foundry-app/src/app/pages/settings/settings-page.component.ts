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
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss',
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
