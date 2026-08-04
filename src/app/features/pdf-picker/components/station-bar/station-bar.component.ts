import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

import type { StationId, StationPresence } from '@shared/document/stations';

/**
 * One station's tab. Every field is DERIVED by the shell from the documents —
 * nothing here is remembered between renders, because a tab that could remember
 * would be a second answer to "does this book have an EPUB".
 */
export interface StationTab {
  readonly id: StationId;
  readonly label: string;
  /**
   * `present` — the artifact is on disk. `absent` — not yet, and the reason
   * names the button that makes it. `not-applicable` — this book never has one,
   * which is a different thing and is drawn differently.
   */
  readonly presence: StationPresence;
  readonly current: boolean;
  /**
   * Why this station cannot be opened, or null when it can. Stations that are
   * not present are SHOWN rather than hidden: the ladder is what the user is
   * walking, and a rung that appears only once you have climbed it teaches
   * nothing about where they are.
   */
  readonly reason: string | null;
}

/**
 * One button offered at the station on screen.
 *
 * The shell decides which buttons a station has and whether each is live,
 * because those are facts about the documents. This component only draws them —
 * so there is no list of station actions in two places to drift apart.
 */
export interface StationAction {
  readonly id: string;
  readonly label: string;
  /** Null when the button is live; otherwise the sentence it is disabled WITH. */
  readonly reason: string | null;
  /** Drawn as the station's main move (there is at most one). */
  readonly primary?: boolean;
}

/**
 * The station bar — which artifact you are looking at, what you can do to it,
 * and where Next goes.
 *
 * Pipeline V2 (docs/PIPELINE_V2_PLAN.md): processing is not a place. Every
 * operation is a button on the station where its INPUT lives, and Next is pure
 * navigation that lights when the next station's artifact exists. This is the
 * one control that says all three things, so they cannot disagree.
 *
 * Purely presentational. It holds nothing at all — not even which tab is open,
 * which is a fact about the file in the viewer and belongs to the shell.
 */
@Component({
  selector: 'app-station-bar',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="station-bar">
      <div class="station-tabs" role="tablist">
        @for (tab of tabs(); track tab.id) {
          <button
            type="button"
            role="tab"
            class="station-tab"
            [class.current]="tab.current"
            [class.absent]="tab.presence === 'absent'"
            [class.not-applicable]="tab.presence === 'not-applicable'"
            [attr.aria-selected]="tab.current"
            [attr.aria-disabled]="tab.presence !== 'present'"
            [disabled]="tab.presence !== 'present' || busy()"
            [title]="tab.reason ?? tab.label"
            (click)="stationClick.emit(tab.id)"
          >
            <span class="station-name">{{ tab.label }}</span>
            <!--
              Two different marks for two different facts. "—" is a rung this
              book has not climbed yet; "n/a" is a rung it does not have, and
              drawing them the same would leave a user waiting for a station
              that is never coming.
            -->
            @switch (tab.presence) {
              @case ('absent') { <span class="station-mark">—</span> }
              @case ('not-applicable') { <span class="station-mark">n/a</span> }
            }
          </button>
        }
      </div>

      <div class="station-row">
        <p class="station-context">{{ contextLine() }}</p>

        <div class="station-actions">
          @for (action of actions(); track action.id) {
            <button
              type="button"
              class="station-action"
              [class.primary]="action.primary === true"
              [disabled]="action.reason !== null || busy()"
              [title]="action.reason ?? action.label"
              (click)="actionClick.emit(action.id)"
            >{{ action.label }}</button>
          }

          <!--
            Next never does work. When it is locked it carries the sentence that
            names the button which would unlock it, and that sentence is the same
            string the ladder gave the shell — said once, in one place.
          -->
          <button
            type="button"
            class="station-next"
            [disabled]="nextReason() !== null || busy()"
            [title]="nextReason() ?? nextLabel()"
            (click)="next.emit()"
          >{{ nextLabel() }}</button>
        </div>
      </div>

      @if (nextReason(); as reason) {
        <p class="station-locked">{{ reason }}</p>
      }
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: block;
      background: var(--bg-toolbar);
      border-bottom: 1px solid var(--border-subtle);
    }

    .station-bar {
      display: flex;
      flex-direction: column;
    }

    .station-tabs {
      display: flex;
      gap: 2px;
      padding: 0 var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
      overflow-x: auto;
    }

    .station-tab {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
      font-size: var(--ui-font-sm);
    }

    .station-tab:hover:not(:disabled) { color: var(--text-primary); }

    .station-tab.current {
      color: var(--text-primary);
      border-bottom-color: var(--accent);
    }

    /* Shown, never hidden: the rung you have not climbed yet is the point. */
    .station-tab.absent {
      color: var(--text-tertiary);
      cursor: not-allowed;
    }

    /* A rung this book does not have. Struck through rather than merely dim, so
       it does not read as one more thing left to do. */
    .station-tab.not-applicable {
      color: var(--text-tertiary);
      cursor: not-allowed;
      text-decoration: line-through;
      opacity: 0.6;
    }

    .station-mark { font-size: var(--ui-font-xs); }

    .station-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
    }

    .station-context {
      flex: 1;
      margin: 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      line-height: 1.4;
    }

    .station-actions {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      flex-wrap: wrap;
    }

    .station-action,
    .station-next {
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: var(--ui-font-sm);
      white-space: nowrap;
    }

    .station-action:hover:not(:disabled),
    .station-next:hover:not(:disabled) { background: var(--bg-hover); }

    .station-action:disabled,
    .station-next:disabled { opacity: 0.45; cursor: not-allowed; }

    .station-action.primary,
    .station-next {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    .station-action.primary:hover:not(:disabled),
    .station-next:hover:not(:disabled) { background: var(--accent-hover); }

    .station-locked {
      margin: 0;
      padding: 0 var(--ui-spacing-md) var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }
  `],
})
export class StationBarComponent {
  readonly tabs = input.required<readonly StationTab[]>();
  readonly actions = input.required<readonly StationAction[]>();
  /** What this station IS, in one line. */
  readonly contextLine = input.required<string>();
  readonly nextLabel = input.required<string>();
  /** Null when Next is live; otherwise the sentence naming what is missing. */
  readonly nextReason = input.required<string | null>();
  /** A stage is running for this book; nothing here should be pressable. */
  readonly busy = input.required<boolean>();

  readonly stationClick = output<StationId>();
  readonly actionClick = output<string>();
  readonly next = output<void>();
}
