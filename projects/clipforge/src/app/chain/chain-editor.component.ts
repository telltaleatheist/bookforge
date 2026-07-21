import {
  ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClipforgeApiService } from '../services/clipforge-api.service';
import {
  ClipforgeEngineInfo, ClipforgeProbe, ClipforgeRecipe, ClipforgeRecipeFile,
  ClipforgeRecipeStep, RunRecipeResult,
} from '../models/types';

/** A step being edited. `settings` is a live, mutable-by-copy bag. */
interface EditorStep {
  engine: string;
  settings: Record<string, unknown>;
}

interface EqBand { freq: number | null; width: number | null; gain: number | null; }

const RECIPE_VERSION = 1;

/**
 * Interactive chain editor: build a recipe as an ordered list of steps, each with
 * a per-engine settings form, then Run it on the selected probe, or Save/Load the
 * recipe as JSON in the collection's recipes/ dir.
 *
 * NO FALLBACKS: guarded engines (lowpass/resample) are NOT pre-blocked here — the
 * checkbox simply reflects the allow flag, and an unchecked run surfaces the real
 * thrown error from the engine. Every failure is shown in a banner, never
 * swallowed. Starting values are visible in the form and fully editable.
 */
@Component({
  selector: 'cf-chain-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="panel">
      <div class="panel-head">
        <h2>Chain editor</h2>
        <div class="recipe-name">
          <label>Recipe name</label>
          <input
            type="text"
            [ngModel]="recipeName()"
            (ngModelChange)="recipeName.set($event)"
            placeholder="My chain"
          />
        </div>
      </div>

      @if (error(); as e) {
        <div class="banner error" (click)="error.set(null)">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info" (click)="notice.set(null)">{{ n }}</div>
      }

      <!-- Steps ---------------------------------------------------------------->
      @if (steps().length === 0) {
        <p class="empty">No steps yet. Add one below to start building the chain.</p>
      } @else {
        <ol class="steps">
          @for (step of steps(); track $index) {
            <li class="step">
              <div class="step-head">
                <span class="step-idx">{{ $index + 1 }}</span>
                <span class="step-engine">{{ step.engine }}</span>
                <span class="spacer"></span>
                <button type="button" class="mini" (click)="moveUp($index)" [disabled]="$index === 0" title="Move up">↑</button>
                <button type="button" class="mini" (click)="moveDown($index)" [disabled]="$index === steps().length - 1" title="Move down">↓</button>
                <button type="button" class="mini danger" (click)="removeStep($index)" title="Remove">✕</button>
              </div>

              <div class="step-body">
                @switch (step.engine) {
                  @case ('highpass') {
                    <div class="field">
                      <label>Frequency</label>
                      <input type="number" min="1" step="1" [ngModel]="numVal(step,'freq')" (ngModelChange)="setNum($index,'freq',$event)" />
                      <span class="unit">Hz</span>
                    </div>
                  }
                  @case ('lowpass') {
                    <div class="field">
                      <label>Frequency</label>
                      <input type="number" min="1" step="1" [ngModel]="numVal(step,'freq')" (ngModelChange)="setNum($index,'freq',$event)" />
                      <span class="unit">Hz</span>
                    </div>
                    <label class="check">
                      <input type="checkbox" [ngModel]="boolVal(step,'allowLowpass')" (ngModelChange)="setBool($index,'allowLowpass',$event)" />
                      I understand low-pass is banned for Orpheus training
                    </label>
                    @if (!boolVal(step,'allowLowpass')) {
                      <p class="warn">Unchecked: the run will throw. Nothing is pre-blocked — the real error is surfaced.</p>
                    }
                  }
                  @case ('eq') {
                    <div class="eq-head">
                      <span>Bands</span>
                      <button type="button" class="mini" (click)="addBand($index)">+ Band</button>
                    </div>
                    @for (band of bandsOf(step); track $index; let bi = $index) {
                      <div class="eq-row">
                        <div class="field small">
                          <label>Freq</label>
                          <input type="number" min="1" step="1" [ngModel]="band.freq" (ngModelChange)="setBand(stepIndexOf(step), bi,'freq',$event)" />
                          <span class="unit">Hz</span>
                        </div>
                        <div class="field small">
                          <label>Width</label>
                          <input type="number" min="1" step="1" [ngModel]="band.width" (ngModelChange)="setBand(stepIndexOf(step), bi,'width',$event)" />
                          <span class="unit">Hz</span>
                        </div>
                        <div class="field small">
                          <label>Gain</label>
                          <input type="number" step="0.5" [ngModel]="band.gain" (ngModelChange)="setBand(stepIndexOf(step), bi,'gain',$event)" />
                          <span class="unit">dB</span>
                        </div>
                        <button type="button" class="mini danger" (click)="removeBand(stepIndexOf(step), bi)" title="Remove band">✕</button>
                      </div>
                    }
                  }
                  @case ('gate') {
                    <div class="field">
                      <label>Threshold</label>
                      <input type="number" step="1" [ngModel]="numVal(step,'thresholdDb')" (ngModelChange)="setNum($index,'thresholdDb',$event)" />
                      <span class="unit">dB</span>
                    </div>
                    <div class="field">
                      <label>Attack</label>
                      <input type="number" min="0" step="1" [ngModel]="numVal(step,'attackMs')" (ngModelChange)="setNum($index,'attackMs',$event)" />
                      <span class="unit">ms</span>
                    </div>
                    <div class="field">
                      <label>Release</label>
                      <input type="number" min="0" step="1" [ngModel]="numVal(step,'releaseMs')" (ngModelChange)="setNum($index,'releaseMs',$event)" />
                      <span class="unit">ms</span>
                    </div>
                  }
                  @case ('silence_truncate') {
                    <div class="field">
                      <label>Threshold</label>
                      <input type="number" step="1" [ngModel]="numVal(step,'thresholdDb')" (ngModelChange)="setNum($index,'thresholdDb',$event)" />
                      <span class="unit">dB</span>
                    </div>
                    <div class="field">
                      <label>Max silence</label>
                      <input type="number" min="0" step="0.05" [ngModel]="numVal(step,'maxSilenceS')" (ngModelChange)="setNum($index,'maxSilenceS',$event)" />
                      <span class="unit">s</span>
                    </div>
                    <div class="field">
                      <label>Keep</label>
                      <input type="number" min="0" step="0.05" [ngModel]="numVal(step,'keepS')" (ngModelChange)="setNum($index,'keepS',$event)" />
                      <span class="unit">s</span>
                    </div>
                    <p class="hint">Changes duration — soloing this stage in audition restarts from 0.</p>
                  }
                  @case ('loudness') {
                    <div class="field">
                      <label>Mode</label>
                      <select [ngModel]="strVal(step,'mode')" (ngModelChange)="setStr($index,'mode',$event)">
                        <option value="loudnorm">loudnorm (EBU R128)</option>
                        <option value="gain">gain (fixed dB)</option>
                      </select>
                    </div>
                    @if (strVal(step,'mode') === 'loudnorm') {
                      <div class="field">
                        <label>I (integrated)</label>
                        <input type="number" step="0.5" [ngModel]="numVal(step,'I')" (ngModelChange)="setNum($index,'I',$event)" />
                        <span class="unit">LUFS</span>
                      </div>
                      <div class="field">
                        <label>TP (true peak)</label>
                        <input type="number" step="0.5" [ngModel]="numVal(step,'TP')" (ngModelChange)="setNum($index,'TP',$event)" />
                        <span class="unit">dBTP</span>
                      </div>
                      <div class="field">
                        <label>LRA (range)</label>
                        <input type="number" min="0" step="0.5" [ngModel]="numVal(step,'LRA')" (ngModelChange)="setNum($index,'LRA',$event)" />
                        <span class="unit">LU</span>
                      </div>
                    } @else {
                      <div class="field">
                        <label>Gain</label>
                        <input type="number" step="0.5" [ngModel]="numVal(step,'gainDb')" (ngModelChange)="setNum($index,'gainDb',$event)" />
                        <span class="unit">dB</span>
                      </div>
                    }
                  }
                  @case ('resample') {
                    <div class="field">
                      <label>Rate</label>
                      <input type="number" min="1" step="1" [ngModel]="numVal(step,'rate')" (ngModelChange)="setNum($index,'rate',$event)" />
                      <span class="unit">Hz</span>
                    </div>
                    <label class="check">
                      <input type="checkbox" [ngModel]="boolVal(step,'allowResample')" (ngModelChange)="setBool($index,'allowResample',$event)" />
                      I understand silent resampling caused the RVC blur — enable resample
                    </label>
                    @if (!boolVal(step,'allowResample')) {
                      <p class="warn">Unchecked: the run will throw. Nothing is pre-blocked — the real error is surfaced.</p>
                    }
                  }
                  @default {
                    <p class="warn">No settings form for engine "{{ step.engine }}". Running it will throw.</p>
                  }
                }
              </div>
            </li>
          }
        </ol>
      }

      <!-- Add step ------------------------------------------------------------->
      <div class="add-row">
        <select [ngModel]="addEngine()" (ngModelChange)="addEngine.set($event)" aria-label="Engine to add">
          <option value="">Add a step…</option>
          @for (e of engines(); track e.engine) {
            <option [value]="e.engine" [disabled]="!e.available">
              {{ e.engine }}{{ e.available ? '' : ' — ' + e.description }}
            </option>
          }
        </select>
        <button type="button" class="btn ghost" (click)="addStep()" [disabled]="!addEngine()">Add step</button>
      </div>

      <!-- Actions -------------------------------------------------------------->
      <div class="actions">
        <button type="button" class="btn" (click)="run()" [disabled]="busy() || steps().length === 0">
          {{ busy() ? 'Running…' : 'Run chain on this probe' }}
        </button>
        <button type="button" class="btn ghost" (click)="save()" [disabled]="busy() || steps().length === 0">Save recipe</button>
        <button type="button" class="btn ghost" (click)="toggleLoad()" [disabled]="busy()">
          {{ showLoad() ? 'Hide recipes' : 'Load recipe' }}
        </button>
      </div>

      @if (showLoad()) {
        <div class="load-panel">
          @if (recipeFiles().length === 0) {
            <p class="empty">No saved recipes in this collection's recipes/ dir.</p>
          } @else {
            <ul class="recipe-list">
              @for (f of recipeFiles(); track f.filename) {
                <li class="recipe-item" [class.bad]="!!f.error">
                  <div class="recipe-meta">
                    <span class="recipe-title">{{ f.name }}</span>
                    <span class="recipe-file">{{ f.filename }}</span>
                    @if (f.error) { <span class="recipe-err">{{ f.error }}</span> }
                  </div>
                  <button type="button" class="mini" (click)="loadRecipe(f)" [disabled]="!f.recipe">Load</button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    .panel {
      background: var(--bg-card); border: 1px solid var(--border-default);
      border-radius: 10px; padding: var(--ui-spacing-lg, 16px); margin-bottom: var(--ui-spacing-lg, 16px);
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: var(--ui-spacing-md, 12px); flex-wrap: wrap; }
    h2 { font-size: var(--ui-font-lg, 18px); color: var(--text-primary); }
    .recipe-name { display: flex; align-items: center; gap: 8px; }
    .recipe-name label { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .recipe-name input {
      height: 32px; width: 220px; background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-input); border-radius: 6px; padding: 0 8px;
    }
    .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: var(--ui-font-sm, 13px); cursor: default; }
    .banner.error { background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error); }
    .banner.info { background: var(--accent-subtle); color: var(--text-secondary); border: 1px solid var(--border-default); }
    .empty { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .steps { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .step { border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-surface); }
    .step-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); }
    .step-idx {
      width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: var(--text-inverse);
      display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
    }
    .step-engine { color: var(--text-primary); font-weight: 600; font-size: var(--ui-font-sm, 13px); }
    .spacer { flex: 1; }
    .mini {
      min-width: 28px; height: 28px; padding: 0 8px; border-radius: 6px;
      border: 1px solid var(--border-strong); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer;
    }
    .mini:disabled { opacity: 0.4; cursor: default; }
    .mini.danger { color: var(--error-text); }
    .step-body { padding: 10px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
    .field { display: flex; align-items: center; gap: 6px; }
    .field.small { gap: 4px; }
    .field label { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); min-width: 64px; }
    .field.small label { min-width: 34px; }
    .field input, .field select {
      height: 32px; background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-input); border-radius: 6px; padding: 0 8px;
    }
    .field input[type=number] { width: 92px; }
    .field.small input { width: 74px; }
    .unit { color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px); }
    .check { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: var(--ui-font-sm, 13px); flex-basis: 100%; }
    .warn { flex-basis: 100%; margin: 0; color: var(--warning-text); font-size: var(--ui-font-xs, 11px); }
    .hint { flex-basis: 100%; margin: 0; color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px); }
    .eq-head { display: flex; align-items: center; gap: 10px; flex-basis: 100%; color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .eq-row { display: flex; align-items: center; gap: 12px; flex-basis: 100%; }
    .add-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .add-row select {
      height: 36px; background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-input); border-radius: 6px; padding: 0 8px; min-width: 260px;
    }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      height: var(--ui-btn-height-sm, 44px); padding: 0 16px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--accent); color: var(--text-inverse);
      font-weight: 600; cursor: pointer;
    }
    .btn.ghost { background: var(--bg-elevated); color: var(--text-primary); }
    .btn:disabled { opacity: 0.55; cursor: default; }
    .load-panel { margin-top: 14px; border-top: 1px solid var(--border-subtle); padding-top: 12px; }
    .recipe-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .recipe-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-surface); }
    .recipe-item.bad { border-color: var(--error); }
    .recipe-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .recipe-title { color: var(--text-primary); font-size: var(--ui-font-sm, 13px); font-weight: 600; }
    .recipe-file { color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px); }
    .recipe-err { color: var(--error-text); font-size: var(--ui-font-xs, 11px); }
  `],
})
export class ChainEditorComponent implements OnInit {
  private readonly api = inject(ClipforgeApiService);

  readonly collectionName = input.required<string>();
  readonly probe = input.required<ClipforgeProbe>();

  /** Emitted after a successful run so the parent refreshes + selects the run. */
  readonly ran = output<RunRecipeResult>();

  readonly recipeName = signal<string>('My chain');
  readonly steps = signal<EditorStep[]>([]);
  readonly engines = signal<ClipforgeEngineInfo[]>([]);
  readonly addEngine = signal<string>('');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly showLoad = signal(false);
  readonly recipeFiles = signal<ClipforgeRecipeFile[]>([]);

  async ngOnInit(): Promise<void> {
    try {
      this.engines.set(await this.api.listEngines());
    } catch (err) {
      this.error.set(this.msg(err));
    }
  }

  // ── Step list mutations ─────────────────────────────────────────────────────

  addStep(): void {
    const engine = this.addEngine();
    if (!engine) return;
    this.error.set(null);
    this.notice.set(null);
    this.steps.update((list) => [...list, { engine, settings: this.defaultSettings(engine) }]);
    this.addEngine.set('');
  }

  removeStep(i: number): void {
    this.steps.update((list) => list.filter((_s, idx) => idx !== i));
  }

  moveUp(i: number): void {
    if (i <= 0) return;
    this.steps.update((list) => {
      const next = [...list];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }

  moveDown(i: number): void {
    this.steps.update((list) => {
      if (i >= list.length - 1) return list;
      const next = [...list];
      [next[i + 1], next[i]] = [next[i], next[i + 1]];
      return next;
    });
  }

  setNum(i: number, key: string, value: number | null): void {
    this.updateSetting(i, key, value);
  }

  setBool(i: number, key: string, value: boolean): void {
    this.updateSetting(i, key, value);
  }

  setStr(i: number, key: string, value: string): void {
    this.updateSetting(i, key, value);
  }

  private updateSetting(i: number, key: string, value: unknown): void {
    this.steps.update((list) => list.map((s, idx) =>
      idx === i ? { ...s, settings: { ...s.settings, [key]: value } } : s));
  }

  // ── EQ band mutations ───────────────────────────────────────────────────────

  bandsOf(step: EditorStep): EqBand[] {
    const b = step.settings['bands'];
    return Array.isArray(b) ? (b as EqBand[]) : [];
  }

  /** Index of a given step object in the current list (EQ rows lose the outer index). */
  stepIndexOf(step: EditorStep): number {
    return this.steps().indexOf(step);
  }

  addBand(i: number): void {
    this.steps.update((list) => list.map((s, idx) => {
      if (idx !== i) return s;
      const bands = this.bandsOf(s);
      return { ...s, settings: { ...s.settings, bands: [...bands, { freq: 1000, width: 100, gain: 0 }] } };
    }));
  }

  removeBand(i: number, bandIndex: number): void {
    this.steps.update((list) => list.map((s, idx) => {
      if (idx !== i) return s;
      const bands = this.bandsOf(s).filter((_b, bi) => bi !== bandIndex);
      return { ...s, settings: { ...s.settings, bands } };
    }));
  }

  setBand(i: number, bandIndex: number, key: keyof EqBand, value: number | null): void {
    if (i < 0) return;
    this.steps.update((list) => list.map((s, idx) => {
      if (idx !== i) return s;
      const bands = this.bandsOf(s).map((b, bi) => bi === bandIndex ? { ...b, [key]: value } : b);
      return { ...s, settings: { ...s.settings, bands } };
    }));
  }

  // ── Template value accessors ────────────────────────────────────────────────

  numVal(step: EditorStep, key: string): number | null {
    const v = step.settings[key];
    return typeof v === 'number' ? v : null;
  }

  boolVal(step: EditorStep, key: string): boolean {
    return step.settings[key] === true;
  }

  strVal(step: EditorStep, key: string): string {
    const v = step.settings[key];
    return typeof v === 'string' ? v : '';
  }

  // ── Run / Save / Load ───────────────────────────────────────────────────────

  async run(): Promise<void> {
    const recipe = this.buildRecipe();
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const res = await this.api.runRecipe(this.collectionName(), { probeId: this.probe().id }, recipe);
      this.notice.set(`Run complete: ${res.run.outputFilename}`);
      this.ran.emit(res);
    } catch (err) {
      this.error.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const recipe = this.buildRecipe();
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const res = await this.api.saveRecipe(this.collectionName(), recipe);
      this.notice.set(res.alreadyExisted
        ? `Recipe already saved (identical): ${res.filename}`
        : `Saved recipe: ${res.filename}`);
      if (this.showLoad()) await this.refreshRecipes();
    } catch (err) {
      this.error.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  async toggleLoad(): Promise<void> {
    const next = !this.showLoad();
    this.showLoad.set(next);
    if (next) await this.refreshRecipes();
  }

  private async refreshRecipes(): Promise<void> {
    this.error.set(null);
    try {
      this.recipeFiles.set(await this.api.listRecipes(this.collectionName()));
    } catch (err) {
      this.error.set(this.msg(err));
    }
  }

  loadRecipe(file: ClipforgeRecipeFile): void {
    if (!file.recipe) {
      this.error.set(`Recipe "${file.filename}" cannot be loaded: ${file.error ?? 'invalid'}`);
      return;
    }
    this.error.set(null);
    this.recipeName.set(file.recipe.name);
    this.steps.set(file.recipe.steps.map((s: ClipforgeRecipeStep) => ({
      engine: s.engine,
      settings: { ...s.settings },
    })));
    this.notice.set(`Loaded recipe: ${file.filename}`);
    this.showLoad.set(false);
  }

  /**
   * Assemble the recipe from the editor state. Per-engine settings are
   * materialized to exactly the fields that engine consumes (e.g. loudness sends
   * only the active mode's fields) so provenance records nothing spurious.
   */
  private buildRecipe(): ClipforgeRecipe {
    return {
      recipeVersion: RECIPE_VERSION,
      name: this.recipeName().trim(),
      steps: this.steps().map((s) => ({ engine: s.engine, settings: this.materialize(s) })),
    };
  }

  private materialize(step: EditorStep): Record<string, unknown> {
    if (step.engine === 'loudness') {
      const mode = this.strVal(step, 'mode');
      if (mode === 'gain') return { mode, gainDb: step.settings['gainDb'] };
      return { mode, I: step.settings['I'], TP: step.settings['TP'], LRA: step.settings['LRA'] };
    }
    if (step.engine === 'eq') {
      return { bands: this.bandsOf(step).map((b) => ({ freq: b.freq, width: b.width, gain: b.gain })) };
    }
    return { ...step.settings };
  }

  private defaultSettings(engine: string): Record<string, unknown> {
    switch (engine) {
      case 'highpass': return { freq: 80 };
      case 'lowpass': return { freq: 8000, allowLowpass: false };
      case 'eq': return { bands: [{ freq: 3300, width: 200, gain: -6 }] };
      case 'gate': return { thresholdDb: -50, attackMs: 5, releaseMs: 100 };
      case 'silence_truncate': return { thresholdDb: -42, maxSilenceS: 0.5, keepS: 0.2 };
      case 'loudness': return { mode: 'loudnorm', I: -18, TP: -2, LRA: 7, gainDb: 0 };
      case 'resample': return { rate: 24000, allowResample: false };
      default:
        // A form-less engine (e.g. a phase-2b stub added out of band): empty bag,
        // which the engine will reject loudly at run time. NO fabricated settings.
        return {};
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
