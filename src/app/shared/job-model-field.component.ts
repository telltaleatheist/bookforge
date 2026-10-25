/**
 * THE MODEL DROPDOWN A TEXT JOB'S OWN WINDOW CARRIES (Owen, 2026-10-25).
 *
 * Verbatim: *"put the option the user can pick in a dropdown on the modal that
 * configures the job"*; *"cloud accounts should be listed as an option in every
 * model dropdown if its available, just like 27b or 9b or anything else.
 * however, bookforge should use the last used model as the default. the ideal is
 * that the user wont need to use cloud models because theyre expensive. but it
 * should be there if their system is too weak to run a local model"*.
 *
 * ONE field, used by every window that starts a clean, a translate or an
 * analysis, so the four cannot drift into four lists. What it offers is
 * `jobModelChoices` (shared/crucible/job-models.ts), read from the server the
 * job will run on through `bookforge:crucible-job-models`; what it opens on is
 * `defaultJobModel` over the last value used for this KIND of job.
 *
 * It does not remember anything itself. The window that hosts it writes the
 * last-used value when the job is SUBMITTED (`SettingsService.setLastJobModel`),
 * because a row somebody scrolled past is not a choice.
 *
 * The cloud rows are grouped under their own heading, "Cloud — billed to your
 * account", and say whose account on hover. Owen's ideal is that nobody needs
 * them; they are offered, never preferred, and never the first-run default.
 */
import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DesktopSelectComponent, type DesktopSelectItems } from '../creamsicle-desktop';
import { ElectronService } from '../core/services/electron.service';
import { SettingsService } from '../core/services/settings.service';
import {
  AUTOMATIC_JOB_MODEL,
  defaultJobModel,
  type JobModelChoices,
  type JobModelKind,
} from '@shared/crucible/job-models';

@Component({
  selector: 'app-job-model-field',
  standalone: true,
  imports: [FormsModule, DesktopSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="jm-field">
      @if (label()) {
        <label class="jm-label">{{ label() }}</label>
      }
      <desktop-select
        [options]="options()"
        [disabled]="disabled() || list() === null"
        [ngModel]="value()"
        (ngModelChange)="choose($event)"
        [placeholder]="loading() ? 'Asking the server for its models…' : 'No model list'"
        ariaLabel="The model this job runs on"
      />
      @if (hint(); as h) {
        <p class="jm-hint">{{ h }}</p>
      }
      @if (chosenDetail(); as d) {
        <p class="jm-hint">{{ d }}</p>
      }
      @if (list()?.cloudNote; as note) {
        <p class="jm-hint warn">{{ note }}</p>
      }
      @if (error(); as e) {
        <p class="jm-hint bad">
          <span>{{ e }} Until it answers, this job runs on the server's own pick.</span>
          <button type="button" class="jm-recheck" [disabled]="loading()" (click)="load()">
            {{ loading() ? 'Asking…' : 'Re-check' }}
          </button>
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .jm-field { display: flex; flex-direction: column; gap: 6px; }
    .jm-label {
      font-size: 0.6875rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-tertiary);
    }
    .jm-hint {
      margin: 0; font-size: 0.75rem; line-height: 1.45; color: var(--text-secondary);
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
    }
    .jm-hint.warn { color: var(--warning-text); }
    .jm-hint.bad { color: var(--error-text); }
    .jm-recheck {
      font: inherit; font-size: 0.72rem; padding: 1px 8px; cursor: pointer;
      border-radius: 6px; border: 1px solid var(--border-default);
      background: var(--bg-elevated); color: var(--text-primary);
    }
    .jm-recheck:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class JobModelFieldComponent {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);

  /** Which kind of job this is — the last-used value is remembered per kind. */
  readonly kind = input.required<JobModelKind>();
  /**
   * The server the job will run on, or null for the one an unassigned text act
   * would be placed on. The list always names the server it was read from.
   */
  readonly server = input<string | null>(null);
  readonly disabled = input(false);
  /** The field's own heading; '' when the host window draws its own in its own style. */
  readonly label = input('Model');
  /** A sentence of the host window's own, under the control. */
  readonly hint = input<string | null>(null);

  /** The value the job will carry as chosenModel; '' is AUTOMATIC. Emitted on open and on every change. */
  readonly chosen = output<string>();

  readonly list = signal<JobModelChoices | null>(null);
  readonly value = signal<string>(AUTOMATIC_JOB_MODEL);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly options = computed<DesktopSelectItems>(() => {
    const list = this.list();
    if (list === null) return [];
    const local = list.choices.filter((c) => c.kind !== 'cloud');
    const cloud = list.choices.filter((c) => c.kind === 'cloud');
    const items: DesktopSelectItems = [{
      label: `On ${list.server}`,
      options: local.map((c) => ({ value: c.value, label: c.label, title: c.detail ?? undefined })),
    }];
    if (cloud.length > 0) {
      items.push({
        label: 'Cloud — billed to your account',
        options: cloud.map((c) => ({
          value: c.value,
          label: c.label,
          // Once chosen the heading is gone, so the closed control says it too.
          valueLabel: `${c.label} (cloud, billed)`,
          title: c.detail ?? undefined,
        })),
      });
    }
    return items;
  });

  /** The chosen row's second line — whose card, or whose bill. */
  readonly chosenDetail = computed(() => {
    const list = this.list();
    if (list === null) return null;
    return list.choices.find((c) => c.value === this.value())?.detail ?? null;
  });

  constructor() {
    // Read again whenever the server or the kind changes — a model chosen on
    // one server is simply not on another.
    effect(() => {
      this.server();
      this.kind();
      untracked(() => { void this.load(); });
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.electron.crucible.jobModels(this.server());
      if (!res.success || !res.data) {
        this.list.set(null);
        this.error.set(res.error ?? 'The server gave no model list and no reason.');
        this.setValue(AUTOMATIC_JOB_MODEL);
        return;
      }
      this.list.set(res.data);
      this.setValue(defaultJobModel(res.data, this.settings.getLastJobModel(this.kind())));
    } finally {
      this.loading.set(false);
    }
  }

  choose(value: string): void {
    this.setValue(value);
  }

  private setValue(value: string): void {
    this.value.set(value);
    this.chosen.emit(value);
  }
}
