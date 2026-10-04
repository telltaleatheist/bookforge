/**
 * THE PRONUNCIATION GUIDE'S REVIEW — BookForge's own window over a book's guide
 * (`#/pronunciation?project=<dir>`, opened from Foundry's "Review pronunciation").
 *
 * Owen, 2026-10-03: *"they can go back to foundry when its done and review the
 * words"* — every printed form the guide decided, how the narrator will say it,
 * and the spots it was unsure of first. A reading can be changed; a form, or one
 * spot, can be LEFT TO THE NARRATOR: *"the printed text reaches the narrator
 * untouched"*. What is saved is what the next cleanup is handed
 * (electron/pronunciation-review.ts).
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { DesktopButtonComponent } from '../../creamsicle-desktop/components/desktop-button/desktop-button.component';
import {
  DesktopSelectComponent, type DesktopSelectOption,
} from '../../creamsicle-desktop/components/desktop-select/desktop-select.component';
import { ElectronService } from '../../core/services/electron.service';
import {
  LEFT_TO_NARRATOR_MEANING,
  type GuideReview, type GuideReviewForm, type GuideReviewFormEdit, type GuideReviewSense,
} from '@shared/pronunciation-guide';

/** A spot's choice in the review: a meaning by index, left to the narrator, or left to the cleaner. */
type SpotChoice = number | 'narrator' | 'cleaner';

/** One form as the person is editing it. */
interface FormDraft {
  form: GuideReviewForm;
  /** The whole form left to the narrator. */
  leftWhole: boolean;
  readings: string[];
  choices: SpotChoice[];
  open: boolean;
}

const KIND_WORD: Record<GuideReviewForm['kind'], string> = {
  roman: 'numeral',
  caps: 'capitals',
  abbreviation: 'abbreviation',
};

@Component({
  selector: 'app-pronunciation-review',
  standalone: true,
  imports: [FormsModule, DesktopButtonComponent, DesktopSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="review">
      <header class="head">
        <div class="titles">
          <h1>Pronunciation guide</h1>
          <div class="book">{{ review()?.title ?? '' }}</div>
        </div>
        <div class="actions">
          @if (saved()) { <span class="saved">{{ saved() }}</span> }
          <desktop-button variant="ghost" size="sm" (click)="load()" [disabled]="busy()">Reload</desktop-button>
          <desktop-button variant="primary" size="sm" (click)="save()" [disabled]="busy() || !dirty()">Save</desktop-button>
        </div>
      </header>

      @if (error()) { <div class="error">{{ error() }}</div> }

      @if (review(); as r) {
        <div class="summary">
          {{ drafts().length }} printed form(s) · {{ spotTotal() }} spot(s)
          @if (undecidedTotal() > 0) { · <strong>{{ undecidedTotal() }} undecided</strong> — the cleaner reads those in their sentence }
        </div>
        <p class="note">
          A reading left empty is said as printed. "Leave to the narrator" sends the printed text to the narrator
          untouched — the cleaner cannot change it. Your decisions last until the guide is started from zero.
        </p>

        <div class="forms">
          @for (d of drafts(); track d.form.kind + d.form.key) {
            <section class="form" [class.undecided]="undecidedIn(d) > 0">
              <div class="form-head">
                <span class="printed">{{ d.form.key }}</span>
                <span class="kind">{{ kindWord(d.form.kind) }}</span>
                <span class="count">{{ d.form.count }}×</span>
                @if (d.form.by === 'person') { <span class="by">yours</span> }
                @if (undecidedIn(d) > 0) { <span class="flag">{{ undecidedIn(d) }} undecided</span> }
                <span class="grow"></span>
                @if (d.leftWhole) {
                  <span class="left">Left to the narrator — said as printed</span>
                  @if (d.form.senses.length > 0) {
                    <desktop-button variant="ghost" size="xs" (click)="setLeftWhole(d, false)">Undo</desktop-button>
                  }
                } @else {
                  <desktop-button variant="ghost" size="xs" (click)="setLeftWhole(d, true)">Leave to the narrator</desktop-button>
                }
              </div>

              @if (!d.leftWhole) {
                <div class="senses">
                  @for (sense of d.form.senses; track $index; let i = $index) {
                    <div class="sense">
                      <div class="meaning">{{ sense.meaning }}</div>
                      <input class="reading" type="text" [ngModel]="d.readings[i]" (ngModelChange)="setReading(d, i, $event)"
                        placeholder="as printed" [attr.aria-label]="'Reading for ' + sense.meaning" />
                      <span class="spots-in">{{ spotsIn(d, i) }} spot(s)</span>
                      @if (sense.problem) { <div class="problem">Not given to the book: {{ sense.problem }}</div> }
                    </div>
                  }
                </div>
                @if (d.form.spots.length > 0) {
                  <button class="toggle" type="button" (click)="toggle(d)">
                    {{ d.open ? 'Hide' : 'Show' }} {{ d.form.spots.length }} spot(s)
                  </button>
                }
                @if (d.open) {
                  <ol class="spots">
                    @for (spot of orderedSpots(d); track spot.index) {
                      <li class="spot" [class.undecided]="d.choices[spot.index] === 'cleaner'">
                        <div class="sentence">
                          @if (spot.sentence === null) {
                            <em>(this spot is no longer printed where the guide saw it)</em>
                          } @else {
                            {{ spot.before }}<mark>{{ spot.mark }}</mark>{{ spot.after }}
                          }
                        </div>
                        <desktop-select size="sm" [options]="optionsFor(d)" [ngModel]="d.choices[spot.index]"
                          (ngModelChange)="setChoice(d, spot.index, $event)" ariaLabel="How this spot is said" />
                      </li>
                    }
                  </ol>
                }
              }
            </section>
          }
        </div>
      } @else if (!busy() && !error()) {
        <div class="empty">This book has no pronunciation guide yet.</div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: auto; background: var(--bg-base); color: var(--text-primary); }
    .review { max-width: 960px; margin: 0 auto; padding: 36px 24px 48px; }
    .head { display: flex; align-items: flex-end; gap: 16px; margin-bottom: 12px; }
    .titles { flex: 1; min-width: 0; }
    h1 { font-size: 20px; margin: 0; font-weight: 600; }
    .book { color: var(--text-secondary); font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; align-items: center; gap: 8px; }
    .saved { color: var(--success-text); font-size: 12px; }
    .error { background: var(--error-bg); color: var(--error-text); padding: 10px 12px; border-radius: 6px; margin: 8px 0; font-size: 13px; }
    .summary { font-size: 13px; color: var(--text-secondary); margin: 4px 0; }
    .note { font-size: 12px; color: var(--text-tertiary); margin: 4px 0 16px; line-height: 1.5; }
    .forms { display: flex; flex-direction: column; gap: 10px; }
    .form { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px 14px; }
    .form.undecided { border-color: var(--border-accent); }
    .form-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .printed { font-family: ui-monospace, Consolas, monospace; font-size: 15px; font-weight: 600; }
    .kind, .count, .by { font-size: 11px; color: var(--text-tertiary); }
    .by { color: var(--text-accent); }
    .flag { font-size: 11px; color: var(--text-accent); font-weight: 600; }
    .grow { flex: 1; }
    .left { font-size: 12px; color: var(--text-secondary); }
    .senses { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
    .sense { display: grid; grid-template-columns: minmax(0, 1fr) 220px 70px; gap: 10px; align-items: center; }
    .meaning { font-size: 13px; color: var(--text-secondary); }
    .reading { height: var(--ui-btn-height-sm); padding: 0 8px; border-radius: 5px; border: 1px solid var(--border-input);
      background: var(--bg-input); color: var(--text-primary); font-size: 13px; }
    .reading:focus { outline: none; box-shadow: var(--focus-ring); }
    .spots-in { font-size: 11px; color: var(--text-tertiary); text-align: right; }
    .problem { grid-column: 1 / -1; font-size: 11px; color: var(--error-text); }
    .toggle { margin-top: 10px; background: none; border: none; padding: 0; color: var(--text-accent); font-size: 12px; cursor: pointer; }
    .spots { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .spot { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 10px; align-items: center;
      padding: 6px 8px; border-radius: 6px; background: var(--bg-sunken); }
    .spot.undecided { box-shadow: inset 3px 0 0 var(--accent); }
    .sentence { font-size: 13px; line-height: 1.45; color: var(--text-secondary); }
    mark { background: var(--accent-subtle); color: var(--text-primary); border-radius: 3px; padding: 0 2px; }
    .empty { color: var(--text-secondary); font-size: 13px; margin-top: 24px; }
  `],
})
export class PronunciationReviewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly electron = inject(ElectronService);

  readonly review = signal<GuideReview | null>(null);
  readonly drafts = signal<FormDraft[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  /** The drafts as last read or saved, for "is there anything to save". */
  private readonly baseline = signal('');

  readonly spotTotal = computed(() => this.drafts().reduce((n, d) => n + d.form.spots.length, 0));
  readonly undecidedTotal = computed(() => this.drafts().reduce((n, d) => n + this.undecidedIn(d), 0));
  readonly dirty = computed(() => this.review() !== null && this.snapshot(this.drafts()) !== this.baseline());

  private projectDir = '';

  constructor() {
    const project = this.route.snapshot.queryParamMap.get('project');
    if (project === null || project === '') {
      this.error.set('This window was opened without a book.');
      return;
    }
    this.projectDir = project;
    void this.load();
  }

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.saved.set(null);
    try {
      const res = await this.electron.readPronunciationGuide(this.projectDir);
      if (!res.success) { this.error.set(res.error ?? 'The guide could not be read.'); return; }
      const review = res.review ?? null;
      this.review.set(review);
      const drafts = review === null ? [] : this.order(review.forms.map((form) => this.draftOf(form)));
      this.drafts.set(drafts);
      this.baseline.set(this.snapshot(drafts));
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const review = this.review();
    if (review === null) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const forms = this.drafts().map((d) => this.editOf(d));
      const res = await this.electron.savePronunciationGuide({ projectDir: review.projectDir, version: review.version, forms });
      if (!res.success) { this.error.set(res.error ?? 'The review could not be saved.'); return; }
      await this.load();
      this.saved.set(`Saved — ${res.forms ?? 0} form(s) and ${res.spots ?? 0} spot(s) changed`);
    } finally {
      this.busy.set(false);
    }
  }

  kindWord(kind: GuideReviewForm['kind']): string { return KIND_WORD[kind]; }

  /**
   * Spots that need a decision — only of a form the guide reads differently. A
   * form said as printed in every meaning is said as printed wherever it falls,
   * so its unplaced spots are not news (the run's own "left to their sentence"
   * counts the same way).
   */
  undecidedIn(d: FormDraft): number {
    if (d.leftWhole || d.form.decision !== 'reading') return 0;
    return d.choices.filter((c) => c === 'cleaner').length;
  }

  spotsIn(d: FormDraft, sense: number): number {
    return d.choices.filter((c) => c === sense).length;
  }

  toggle(d: FormDraft): void { this.update(d, { open: !d.open }); }

  setLeftWhole(d: FormDraft, left: boolean): void { this.update(d, { leftWhole: left }); }

  setReading(d: FormDraft, i: number, value: string): void {
    const readings = [...d.readings];
    readings[i] = value;
    this.update(d, { readings });
  }

  setChoice(d: FormDraft, index: number, value: SpotChoice): void {
    const choices = [...d.choices];
    choices[index] = value;
    this.update(d, { choices });
  }

  optionsFor(d: FormDraft): DesktopSelectOption[] {
    const meanings = d.form.senses
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.meaning !== LEFT_TO_NARRATOR_MEANING)
      .map(({ s, i }) => ({ value: i, label: `${s.meaning} — "${d.readings[i] === '' ? d.form.key : d.readings[i]}"` }));
    return [
      ...meanings,
      { value: 'narrator', label: 'Leave to the narrator (as printed)' },
      { value: 'cleaner', label: 'Undecided — the cleaner reads it in its sentence' },
    ];
  }

  /** The spots, undecided first, each with its sentence split around the printed form. */
  orderedSpots(d: FormDraft): { index: number; sentence: string | null; before: string; mark: string; after: string }[] {
    const rows = d.form.spots.map((spot, index) => {
      const sentence = spot.sentence;
      if (sentence === null) return { index, sentence, before: '', mark: '', after: '' };
      const at = sentence.indexOf(spot.printed);
      return at < 0
        ? { index, sentence, before: sentence, mark: '', after: '' }
        : { index, sentence, before: sentence.slice(0, at), mark: spot.printed, after: sentence.slice(at + spot.printed.length) };
    });
    return [...rows.filter((r) => d.choices[r.index] === 'cleaner'), ...rows.filter((r) => d.choices[r.index] !== 'cleaner')];
  }

  private draftOf(form: GuideReviewForm): FormDraft {
    const narrator = form.senses.findIndex((s) => s.meaning === LEFT_TO_NARRATOR_MEANING);
    const choices: SpotChoice[] = form.spots.map((spot) => {
      if (spot.sense === null) return 'cleaner';
      return spot.sense === narrator ? 'narrator' : spot.sense;
    });
    const leftWhole = form.decision === 'as-printed' && form.senses.length === 0;
    return {
      form,
      leftWhole,
      readings: form.senses.map((s) => s.reading),
      choices,
      open: choices.some((c) => c === 'cleaner'),
    };
  }

  /** Undecided forms first, then by how often the book prints them. */
  private order(drafts: FormDraft[]): FormDraft[] {
    return [...drafts].sort((a, b) => (this.undecidedIn(b) > 0 ? 1 : 0) - (this.undecidedIn(a) > 0 ? 1 : 0)
      || b.form.count - a.form.count);
  }

  private editOf(d: FormDraft): GuideReviewFormEdit {
    const base = { key: d.form.key, kind: d.form.kind };
    if (d.leftWhole) return { ...base, decision: 'as-printed', senses: [], spots: [] };
    const senses: GuideReviewSense[] = d.form.senses.map((s, i) => ({
      meaning: s.meaning, reading: d.readings[i]!.trim(), periodIsPart: s.periodIsPart,
      ...(s.problem === undefined ? {} : { problem: s.problem }),
    }));
    let narrator = senses.findIndex((s) => s.meaning === LEFT_TO_NARRATOR_MEANING);
    if (narrator < 0 && d.choices.includes('narrator')) {
      senses.push({ meaning: LEFT_TO_NARRATOR_MEANING, reading: '', periodIsPart: false });
      narrator = senses.length - 1;
    }
    // The guide's own word stands unless the readings changed; a reading given makes it one.
    const untouched = senses.length === d.form.senses.length
      && senses.every((s, i) => s.reading === d.form.senses[i]!.reading);
    const decision = untouched ? d.form.decision : senses.some((s) => s.reading !== '') ? 'reading' : 'as-printed';
    return {
      ...base,
      decision,
      senses,
      spots: d.form.spots.map((spot, i) => {
        const choice = d.choices[i]!;
        const sense = choice === 'cleaner' ? null : choice === 'narrator' ? narrator : choice;
        return { at: spot.at, nth: spot.nth, printed: spot.printed, sense };
      }),
    };
  }

  private snapshot(drafts: readonly FormDraft[]): string {
    return JSON.stringify(drafts.map((d) => [d.leftWhole, d.readings, d.choices]));
  }

  private update(d: FormDraft, change: Partial<FormDraft>): void {
    this.saved.set(null);
    this.drafts.update((all) => all.map((x) => (x === d ? { ...x, ...change } : x)));
  }
}
