/**
 * The narration modal: say what should be done to this book's audio, and it
 * goes to the queue.
 *
 * ── Owen's two rules, both structural ───────────────────────────────────────
 *
 * "maybe we turn the tts/assembly page into a modal that appears when the user
 * hits process on the tts file" — and — "whatever the user chooses to do
 * (particularly translate/simplify/tts/assemble) will be added to the queue
 * instead of done right there on the spot."
 *
 * So this dialog decides nothing and runs nothing. It collects choices and
 * enqueues rows the user can watch and cancel on the Queue tab.
 *
 * ── The identity law ────────────────────────────────────────────────────────
 *
 * "the tts pipeline knows exactly which file its working with because the user
 * came to the tts page FROM the button on that document. no ambiguity, no
 * confusion."
 *
 * The file is an INPUT. It is not looked up, not resolved, and not defaulted,
 * and the dialog SHOWS it — because a run that narrates the wrong file looks
 * completely ordinary until somebody listens to the result.
 *
 * ── WHY IT CAME BACK, AND WHY IT IS THREE TABS ──────────────────────────────
 *
 * It was orphaned on 2026-08-18, when narration moved into Foundry's window and
 * the questions crossed the socket as a static form description. That form could
 * not ask a conditional question — Foundry's dialog language has no "show this
 * only when that is set" and says so — so the engine picker, the RVC on/off
 * choice and every rate went unasked, read from Settings instead.
 *
 * Owen's ruling of 2026-08-26 reversed the location and widened the questions:
 * *"Foundry is just for text changes, not for audio changes."* The dialog lives
 * here, Foundry's Narrate button raises this window and opens it, and it asks
 * everything a conversion actually needs — including the ones that only make
 * sense together (hop length means nothing beside rmvpe; protect does nothing at
 * index rate 0). Three tabs because there are three separable decisions —
 * how it is READ, how it is ASSEMBLED, how it is CONVERTED — and a single column
 * of twenty controls was what Owen called ugly.
 *
 * ── The stages are chosen, not implied ─────────────────────────────────────
 *
 * Narrate / Convert / Assemble are three independent toggles above the tabs, and
 * the run description takes them as three (shared/queue/narration-run.ts). The
 * combinations that are not runs are refused ON SCREEN in a sentence rather than
 * prevented by moving a toggle the user did not touch, so nobody has to work out
 * why the thing they clicked bounced.
 *
 * ── Why the jobs are not built here ─────────────────────────────────────────
 *
 * They are built by `queue/jobs/narration-run.ts`, over the shared description
 * that this dialog, the language-learning wizard and Foundry's own door all ask.
 * Three doors composing their own runs is how one of them ends up a field behind
 * the others, and the field that goes missing is always the one nobody notices
 * until an hour of GPU has been spent.
 */
import {
  Component, ChangeDetectionStrategy, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopSelectComponent, type DesktopSelectItems } from '../../../../creamsicle-desktop';
import {
  SettingsService, type PipelinePreset,
} from '../../../../core/services/settings.service';
import { LibraryService } from '../../../../core/services/library.service';
import { ComponentService } from '../../../../core/services/component.service';
import { WorkerConfigService } from '../../../../core/services/worker-config.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { QueueService } from '../../../queue/services/queue.service';
import { NarrationVoicesService } from '../../../queue/jobs/narration-voices.service';
import {
  buildNarrationJobs,
  type NarrationRunBook,
  type NarrationRunSettings,
} from '../../../queue/jobs/narration-run';
import {
  engineCaps, selectableEngines,
} from '../../../language-learning/models/tts-engine-registry';
import type { TTSEngine } from '../../../language-learning/models/language-learning.types';

/**
 * The sentences this project already has on disk, as main reports them.
 *
 * READ FROM `reassembly.getBfpSession`, which is the same call the queue steps
 * make when a cache-only row resolves its own session — so what this dialog
 * offers and what those steps find cannot disagree.
 *
 * It is deliberately NOT `parallelTts.cachedRender`, which the resume prompt
 * used: that call answers "is there a PART-FINISHED render" and returns null the
 * moment a render completes. A finished render is exactly the case the
 * convert-and-assemble stages exist for — an audiobook made weeks ago, whose
 * sentences are still cached — so asking that question would have greyed out
 * those stages precisely when they were wanted.
 */
interface CachedSentences {
  readonly processDir: string;
  readonly language: string;
  readonly completedSentences: number;
  readonly totalSentences: number;
  /** Every sentence rendered. False means a resume is on offer. */
  readonly complete: boolean;
  /** The engine and voice that rendered them, when the session recorded it. */
  readonly voice?: string;
}

/** Which tab is showing. */
type NarrationTab = 'tts' | 'assembly' | 'rvc';

/**
 * The pitch extractors this dialog offers.
 *
 * fcpe is urvc's fourth and is deliberately absent: it needs a model this app
 * does not ship, so offering it would be a choice that fails inside the job.
 */
const F0_METHODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'rmvpe', label: 'RMVPE' },
  { value: 'crepe', label: 'CREPE' },
  { value: 'crepe-tiny', label: 'CREPE tiny' },
];

/** The methods whose analysis actually reads a hop length. */
const CREPE_FAMILY: ReadonlySet<string> = new Set(['crepe', 'crepe-tiny']);

/** The basename of a path, for showing WHICH file without the whole path. */
function fileName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fullPath;
}

@Component({
  selector: 'app-narration-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, DesktopSelectComponent],
  template: `
    <div class="nm-backdrop" (click)="onCancel()">
      <div class="nm-modal" (click)="$event.stopPropagation()">

        <header class="nm-head">
          <h3 class="nm-title">Make an audiobook</h3>
          <!-- WHICH file. Shown, not implied: the run is about one document and
               the user is owed the chance to notice it is the wrong one. -->
          <div class="nm-file" [title]="epubPath()">
            <span class="nm-file-icon">📖</span>
            <span class="nm-file-name">{{ fileLabel() }}</span>
          </div>
        </header>

        @if (refusal(); as why) {
          <div class="nm-err">{{ why }}</div>
        } @else {

          <!-- ── The three acts ──────────────────────────────────────────── -->
          <div class="nm-stages">
            <button type="button" class="nm-stage" [class.on]="narrate()"
                    (click)="narrate.set(!narrate())">
              <span class="nm-stage-name">Narrate</span>
              <span class="nm-stage-note">Read the book aloud</span>
            </button>
            <button type="button" class="nm-stage" [class.on]="rvc()"
                    [disabled]="!rvcInstalled()"
                    [title]="rvcInstalled() ? '' : rvcUnavailableNote"
                    (click)="rvc.set(!rvc())">
              <span class="nm-stage-name">Convert</span>
              <span class="nm-stage-note">Re-render through an RVC voice</span>
            </button>
            <button type="button" class="nm-stage" [class.on]="assemble()"
                    (click)="assemble.set(!assemble())">
              <span class="nm-stage-name">Assemble</span>
              <span class="nm-stage-note">Combine into an M4B</span>
            </button>
          </div>

          @if (stageRefusal(); as why) {
            <p class="nm-plan bad">{{ why }}</p>
          } @else {
            <p class="nm-plan">{{ runSentence() }}</p>
          }

          <!-- ── Tabs ────────────────────────────────────────────────────── -->
          <nav class="nm-tabs" role="tablist">
            <button type="button" role="tab" class="nm-tab"
                    [class.on]="tab() === 'tts'"
                    [attr.aria-selected]="tab() === 'tts'"
                    (click)="tab.set('tts')">Reading</button>
            <button type="button" role="tab" class="nm-tab"
                    [class.on]="tab() === 'rvc'"
                    [attr.aria-selected]="tab() === 'rvc'"
                    (click)="tab.set('rvc')">Voice conversion</button>
            <button type="button" role="tab" class="nm-tab"
                    [class.on]="tab() === 'assembly'"
                    [attr.aria-selected]="tab() === 'assembly'"
                    (click)="tab.set('assembly')">Assembly</button>
          </nav>

          <div class="nm-panel">

            <!-- ── Reading ──────────────────────────────────────────────── -->
            @if (tab() === 'tts') {
              @if (!narrate()) {
                <p class="nm-hint">
                  This run does not read the book — it works from the sentences already
                  rendered for it. Nothing on this tab affects it.
                </p>
              }

              <!-- A half-finished render of this book is on disk. Until this
                   block existed the queue silently resumed it, which is right
                   when it is the same book and wrong when it is not — Owen
                   re-exported an EPUB after new strikes and got the old
                   render's leftovers. -->
              @if (narrate() && resumable(); as cached) {
                <div class="nm-field nm-resume">
                  <label class="nm-label">There is a part-finished narration of this book</label>
                  <p class="nm-hint">
                    {{ cached.completedSentences | number }} of
                    {{ cached.totalSentences | number }} sentences were already rendered.
                  </p>
                  <div class="nm-choices">
                    <button type="button" class="nm-choice"
                            [class.on]="resumeChoice() === 'resume'"
                            (click)="resumeChoice.set('resume')">Carry on from there</button>
                    <button type="button" class="nm-choice"
                            [class.on]="resumeChoice() === 'fresh'"
                            (click)="resumeChoice.set('fresh')">Start over</button>
                  </div>
                  @if (resumeChoice() === 'fresh') {
                    <p class="nm-hint warn">
                      The rendered sentences are deleted and the book is read again from
                      the beginning. Choose this when the text has changed.
                    </p>
                  }
                </div>
              }

              <div class="nm-field">
                <label class="nm-label">Engine</label>
                <div class="nm-choices">
                  @for (eng of engines(); track eng.id) {
                    <button type="button" class="nm-choice"
                            [class.on]="engine() === eng.id"
                            [disabled]="!narrate()"
                            [title]="eng.statusText"
                            (click)="selectEngine(eng.id)">{{ eng.displayName }}</button>
                  }
                </div>
              </div>

              <div class="nm-field">
                <label class="nm-label">Voice</label>
                <desktop-select
                  [options]="voiceOptions()"
                  [disabled]="!narrate()"
                  [ngModel]="voice()"
                  (ngModelChange)="voice.set($event)"
                />
              </div>

              <div class="nm-field">
                <label class="nm-label">Device</label>
                <div class="nm-choices">
                  @for (d of devices; track d.id) {
                    <button type="button" class="nm-choice" [class.on]="device() === d.id"
                            [disabled]="!narrate()"
                            (click)="device.set(d.id)">{{ d.label }}</button>
                  }
                </div>
              </div>

              <div class="nm-field">
                <label class="nm-label">Speed: {{ speed() }}&times;</label>
                <input type="range" class="nm-slider" min="0.5" max="2" step="0.05"
                       [disabled]="!narrate()"
                       [value]="speed()" (input)="speed.set(+$any($event.target).value)" />
              </div>

              @if (maxWorkers() > 1) {
                <div class="nm-field">
                  <label class="nm-label">Workers: {{ workers() }}</label>
                  <input type="range" class="nm-slider" min="1" [max]="maxWorkers()" step="1"
                         [disabled]="!narrate()"
                         [value]="workers()" (input)="workers.set(+$any($event.target).value)" />
                  <span class="nm-hint">More workers render faster on CPU. A GPU run uses one.</span>
                </div>
              }

              <!-- The sampling trio is the ENGINE's, not the dialog's: Orpheus
                   and Voxtral fix theirs inside the engine class, so drawing
                   these for them would be three controls that change nothing. -->
              @if (showsSampling()) {
                <div class="nm-field">
                  <label class="nm-label">Temperature: {{ temperature() }}</label>
                  <input type="range" class="nm-slider" min="0.1" max="1.0" step="0.05"
                         [disabled]="!narrate()"
                         [value]="temperature()"
                         (input)="temperature.set(+$any($event.target).value)" />
                </div>
                <div class="nm-field">
                  <label class="nm-label">Top P: {{ topP() }}</label>
                  <input type="range" class="nm-slider" min="0.1" max="1.0" step="0.05"
                         [disabled]="!narrate()"
                         [value]="topP()" (input)="topP.set(+$any($event.target).value)" />
                </div>
                <div class="nm-field">
                  <label class="nm-label">Repetition penalty: {{ repetitionPenalty() }}</label>
                  <input type="range" class="nm-slider" min="1" max="10" step="0.5"
                         [disabled]="!narrate()"
                         [value]="repetitionPenalty()"
                         (input)="repetitionPenalty.set(+$any($event.target).value)" />
                </div>
              } @else {
                <p class="nm-hint">
                  {{ engineDisplayName() }} sets its own temperature, top-p and repetition
                  penalty inside the engine, so there is nothing here to move.
                </p>
              }
            }

            <!-- ── Voice conversion ─────────────────────────────────────── -->
            @if (tab() === 'rvc') {
              @if (!rvcInstalled()) {
                <p class="nm-hint">{{ rvcUnavailableNote }}</p>
              } @else {
                @if (!rvc()) {
                  <p class="nm-hint">
                    Voice conversion is off for this run. Turn on Convert above to use these
                    settings — picking a preset turns it on for you.
                  </p>
                }

                <!-- The preset picker leads, because a preset is a VOICE PAIR
                     and not a set of rates: it carries the reading voice and the
                     conversion voice that were auditioned together. -->
                <div class="nm-field">
                  <label class="nm-label">Preset</label>
                  <desktop-select
                    [options]="presetOptions()"
                    [ngModel]="activePresetId()"
                    (ngModelChange)="applyPreset($event)"
                  />
                  <span class="nm-hint">
                    A preset sets the reading voice and the conversion together — the pair
                    was chosen by ear, and half of one is not a tuning anybody tested.
                  </span>
                </div>

                <div class="nm-field nm-saverow">
                  @if (namingPreset()) {
                    <input type="text" class="nm-text" placeholder="Name this preset"
                           [value]="presetName()"
                           (input)="presetName.set($any($event.target).value)" />
                    <button type="button" class="nm-choice" [disabled]="!presetName().trim()"
                            (click)="savePreset()">Save</button>
                    <button type="button" class="nm-choice"
                            (click)="namingPreset.set(false)">Cancel</button>
                  } @else {
                    <button type="button" class="nm-choice"
                            (click)="namingPreset.set(true)">Save these as a preset…</button>
                  }
                </div>

                <div class="nm-field">
                  <label class="nm-label">Conversion voice</label>
                  <desktop-select
                    [options]="rvcVoiceOptions()"
                    [disabled]="!rvc()"
                    [ngModel]="rvcVoiceId()"
                    (ngModelChange)="rvcVoiceId.set($event)"
                  />
                </div>

                <div class="nm-field">
                  <label class="nm-label">Pitch extraction</label>
                  <div class="nm-choices">
                    <button type="button" class="nm-choice" [class.on]="rvcF0Method() === ''"
                            [disabled]="!rvc()"
                            (click)="rvcF0Method.set('')">Engine default</button>
                    @for (m of f0Methods; track m.value) {
                      <button type="button" class="nm-choice"
                              [class.on]="rvcF0Method() === m.value"
                              [disabled]="!rvc()"
                              (click)="rvcF0Method.set(m.value)">{{ m.label }}</button>
                    }
                  </div>
                  <span class="nm-hint">
                    Engine default leaves the choice to the converter. Which method suits a
                    pair of voices is decided by ear — there is no rule.
                  </span>
                </div>

                <div class="nm-field">
                  <label class="nm-label">
                    Hop length: {{ rvcHopLength() === 0 ? 'engine default' : rvcHopLength() }}
                  </label>
                  <input type="range" class="nm-slider" min="0" max="512" step="32"
                         [disabled]="!rvc() || !hopApplies()"
                         [value]="rvcHopLength()"
                         (input)="rvcHopLength.set(+$any($event.target).value)" />
                  <span class="nm-hint">
                    @if (hopApplies()) {
                      Analysis interval for the CREPE pitch tracker. 0 leaves it to the engine.
                    } @else {
                      Only CREPE reads this — RMVPE ignores it entirely, so it is off while
                      the method above is not a CREPE.
                    }
                  </span>
                </div>

                <div class="nm-field">
                  <label class="nm-label">Pitch shift: {{ rvcNSemitones() }} semitones</label>
                  <input type="range" class="nm-slider" min="-24" max="12" step="1"
                         [disabled]="!rvc()"
                         [value]="rvcNSemitones()"
                         (input)="rvcNSemitones.set(+$any($event.target).value)" />
                </div>

                <div class="nm-field">
                  <label class="nm-label">Index rate: {{ rvcIndexRate() }}</label>
                  <input type="range" class="nm-slider" min="0" max="1" step="0.05"
                         [disabled]="!rvc()"
                         [value]="rvcIndexRate()"
                         (input)="rvcIndexRate.set(+$any($event.target).value)" />
                  <span class="nm-hint">How far the conversion leans on the model's timbre index.</span>
                </div>

                <div class="nm-field">
                  <label class="nm-label">
                    Consonant protection: {{ protectLabel() }}
                  </label>
                  <input type="range" class="nm-slider" min="0" max="0.5" step="0.05"
                         [disabled]="!rvc()"
                         [value]="rvcProtectRate()"
                         (input)="rvcProtectRate.set(+$any($event.target).value)" />
                  <!-- LABELLED THE WAY THE ENGINE BEHAVES, not the way its own help
                       text reads: urvc gates the whole block on "protect < 0.5",
                       so the scale runs backwards from every doc. -->
                  <span class="nm-hint">
                    Lower protects MORE of the original consonants and breaths; 0.5 turns
                    protection off entirely.
                    @if (rvcIndexRate() === 0) {
                      <strong> It does nothing at index rate 0 — raise the index rate for
                      this to have any effect.</strong>
                    }
                  </span>
                </div>
              }
            }

            <!-- ── Assembly ─────────────────────────────────────────────── -->
            @if (tab() === 'assembly') {
              @if (!assemble()) {
                <p class="nm-hint">
                  This run does not assemble an audiobook, so nothing on this tab
                  affects it.
                </p>
              }
              <div class="nm-field">
                <label class="nm-check">
                  <input type="checkbox" [checked]="finalDenoise()" [disabled]="!assemble()"
                         (change)="finalDenoise.set($any($event.target).checked)" />
                  <span>Denoise the finished audio</span>
                </label>
                <label class="nm-check">
                  <input type="checkbox" [checked]="applyDeRing()" [disabled]="!assemble()"
                         (change)="applyDeRing.set($any($event.target).checked)" />
                  <span>Remove ringing</span>
                </label>
              </div>

              <!-- Only drawn when the session's provenance resolves one: the pad
                   this normalizes is one only Orpheus bakes, so a non-Orpheus
                   session gets no field and no normalization. -->
              @if (showGap()) {
                <div class="nm-field">
                  <label class="nm-label">Gap between sentences: {{ sentenceGap() }}s</label>
                  <input type="range" class="nm-slider" min="0" max="2" step="0.05"
                         [disabled]="!assemble()"
                         [value]="sentenceGap()"
                         (input)="onSentenceGapInput(+$any($event.target).value)" />
                  <span class="nm-hint">
                    @if (gapHasModel()) {
                      Pre-filled with the tuned value for {{ gapVoice() }}.
                    } @else {
                      {{ gapVoice() }} has no measured gap yet, so this starts at the
                      house default.
                    }
                  </span>
                </div>
              }
            }
          </div>

          @if (error(); as e) { <div class="nm-err">{{ e }}</div> }
        }

        <div class="nm-actions">
          <button type="button" class="nm-btn" (click)="onCancel()">Cancel</button>
          <button type="button" class="nm-btn primary"
                  [disabled]="submitDisabled()"
                  (click)="onSubmit()">{{ submitting() ? 'Adding…' : 'Add to queue' }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .nm-backdrop {
      position: fixed; inset: 0; z-index: 400;
      background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .nm-modal {
      width: min(620px, 100%); max-height: 88vh;
      display: flex; flex-direction: column;
      background: var(--bg-surface, var(--bg-elevated)); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 12px; padding: 20px 22px 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    }
    .nm-head { display: flex; flex-direction: column; gap: 10px; }
    .nm-title { margin: 0; font-size: 1.05rem; font-weight: 700; }
    /* The document this run is about. A row of its own, because it is the one
       fact the dialog exists to be unambiguous about. */
    .nm-file {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 8px;
      background: var(--bg-base); border: 1px solid var(--border-default, rgba(255,255,255,0.1));
    }
    .nm-file-icon { font-size: 0.95rem; }
    .nm-file-name {
      font-size: 0.84rem; font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* The three acts, given equal weight and equal width: they are one decision
       made three times, not a primary choice with two modifiers. */
    .nm-stages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; }
    .nm-stage {
      display: flex; flex-direction: column; gap: 3px; text-align: left;
      padding: 9px 11px; border-radius: 9px; cursor: pointer; font-family: inherit;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-secondary);
    }
    .nm-stage.on {
      border-color: var(--accent-primary, #06b6d4);
      background: var(--selected-bg-muted, rgba(6,182,212,0.1));
      color: var(--text-primary);
    }
    .nm-stage:disabled { opacity: 0.4; cursor: not-allowed; }
    .nm-stage-name { font-size: 0.82rem; font-weight: 700; }
    .nm-stage-note { font-size: 0.68rem; line-height: 1.3; color: var(--text-tertiary); }

    /* One plain sentence saying what this run does and what it leaves behind. */
    .nm-plan {
      margin: 12px 0 0; padding: 9px 11px; border-radius: 8px;
      font-size: 0.76rem; line-height: 1.5;
      background: var(--bg-base); color: var(--text-secondary);
      border-left: 3px solid var(--accent-primary, #06b6d4);
    }
    .nm-plan.bad { border-left-color: var(--accent-danger, #ef4444); color: var(--text-primary); }

    .nm-tabs {
      display: flex; gap: 2px; margin-top: 16px;
      border-bottom: 1px solid var(--border-default, rgba(255,255,255,0.12));
    }
    .nm-tab {
      padding: 8px 14px; border: none; background: none; cursor: pointer;
      font-family: inherit; font-size: 0.78rem; font-weight: 600;
      color: var(--text-tertiary); border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .nm-tab:hover { color: var(--text-secondary); }
    .nm-tab.on { color: var(--text-primary); border-bottom-color: var(--accent-primary, #06b6d4); }

    /* The tabs' shared body scrolls; the stage row, the sentence and the buttons
       stay put, so the run's shape is readable whatever tab is open. */
    .nm-panel { flex: 1 1 auto; overflow-y: auto; padding: 4px 2px 0; min-height: 210px; }

    .nm-field { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
    .nm-field:first-child { margin-top: 8px; }
    .nm-label { font-size: 0.78rem; font-weight: 600; }
    .nm-hint { font-size: 0.72rem; color: var(--text-secondary); line-height: 1.45; margin: 0; }
    /* Start over deletes rendered audio, so it says so in a colour that
       is not the same grey as every other hint in the dialog. */
    .nm-hint.warn { color: var(--warning, #f59e0b); }
    .nm-resume {
      padding: 10px 12px; border: 1px solid var(--border-subtle, rgba(128,128,128,0.28));
      border-radius: 8px; background: rgba(128,128,128,0.06);
    }
    .nm-check { display: flex; align-items: center; gap: 7px; font-size: 0.8rem; cursor: pointer; }
    .nm-choices { display: flex; flex-wrap: wrap; gap: 6px; }
    .nm-choice {
      padding: 6px 12px; border-radius: 7px; font-size: 0.78rem; cursor: pointer;
      font-family: inherit;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
    }
    .nm-choice.on { border-color: var(--accent-primary, #06b6d4); font-weight: 600; }
    .nm-choice:disabled { opacity: 0.4; cursor: not-allowed; }
    .nm-saverow { flex-direction: row; align-items: center; gap: 6px; }
    .nm-text {
      flex: 1 1 auto; padding: 6px 9px; border-radius: 7px; font-family: inherit;
      font-size: 0.78rem;
      border: 1px solid var(--border-input, var(--border-default, rgba(255,255,255,0.12)));
      background: var(--bg-input, var(--bg-base)); color: var(--text-primary);
    }
    .nm-slider { width: 100%; }
    .nm-slider:disabled { opacity: 0.4; }
    .nm-err {
      margin-top: 12px; font-size: 0.78rem; color: var(--error-text, #ef4444); line-height: 1.45;
    }
    .nm-actions {
      display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;
      padding-top: 14px; border-top: 1px solid var(--border-subtle, rgba(128,128,128,0.24));
    }
    .nm-btn {
      padding: 7px 14px; border-radius: 7px; font-size: 0.8rem; cursor: pointer;
      font-family: inherit;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
    }
    .nm-btn.primary {
      border-color: var(--accent-primary, #06b6d4);
      background: var(--accent-primary, #06b6d4); color: #06121a; font-weight: 600;
    }
    .nm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class NarrationModalComponent {
  private readonly settings = inject(SettingsService);
  private readonly library = inject(LibraryService);
  private readonly components = inject(ComponentService);
  private readonly workerCfg = inject(WorkerConfigService);
  private readonly electron = inject(ElectronService);
  private readonly queue = inject(QueueService);
  private readonly voices = inject(NarrationVoicesService);

  /**
   * THE file this run is about — the path the button carried.
   *
   * `required` because a dialog with nothing to narrate is not a state this
   * component has: the button that opens it is on a line that names a document.
   */
  readonly epubPath = input.required<string>();
  /**
   * WHICH VERSION of the book that file is — the other half of its identity.
   *
   * Owen, 2026-08-10: "if the user wants to process a specific TTS document then
   * they click the process button next to it. no ambiguity, no confusion." The
   * row the button is on IS a version of this book and carries its id; nothing
   * on this side could work it out, and a run that guessed would be filed
   * against the wrong edition.
   */
  readonly variantId = input.required<string>();
  readonly projectDir = input.required<string>();
  readonly title = input<string>('');
  readonly author = input<string>('');
  readonly year = input<string>('');
  readonly coverPath = input<string>('');
  readonly outputFilename = input<string>('');
  readonly isArticle = input<boolean>(false);
  readonly cancelled = output<void>();
  /** Rows are in the queue. The host closes and tells the user where to watch. */
  readonly queued = output<{ jobs: number }>();

  readonly f0Methods = F0_METHODS;
  readonly rvcUnavailableNote =
    'The voice-conversion engine is not installed, so this run cannot re-render the '
    + 'sentences through another voice. Install it under Settings → Add-ons.';

  /**
   * The engines that can be chosen right now — the registry's own gate, so an
   * engine whose environment is not installed is not offered.
   */
  readonly engines = computed(() =>
    selectableEngines((id) => this.components.isInstalled(id)));

  readonly devices: ReadonlyArray<{ id: 'auto' | 'gpu' | 'mps' | 'cpu'; label: string }> = [
    { id: 'auto', label: 'Auto' },
    { id: 'gpu', label: 'GPU' },
    { id: 'mps', label: 'Metal' },
    { id: 'cpu', label: 'CPU' },
  ];

  // ── Seeded from Pipeline Defaults ─────────────────────────────────────────
  //
  // Read ONCE, at construction, rather than through a computed: these are the
  // run's settings from here on, and a defaults change while the dialog is open
  // must not silently move a control the user has already set.
  private readonly defaults = this.settings.getPipelineDefaults();

  readonly tab = signal<NarrationTab>('tts');

  readonly narrate = signal(true);
  readonly rvc = signal(this.defaults.rvcEnhancementEnabled);
  readonly assemble = signal(true);

  readonly engine = signal<TTSEngine>(this.defaults.ttsEngine);
  readonly voice = signal<string>(this.defaults.ttsVoice);
  readonly device = signal<'auto' | 'gpu' | 'mps' | 'cpu'>(this.defaults.ttsDevice);
  readonly speed = signal(this.defaults.ttsSpeed);
  readonly temperature = signal(this.defaults.ttsTemperature);
  readonly topP = signal(this.defaults.ttsTopP);
  readonly repetitionPenalty = signal(this.defaults.ttsRepetitionPenalty);
  readonly workers = signal(1);

  readonly finalDenoise = signal(false);
  readonly applyDeRing = signal(false);

  readonly rvcVoiceId = signal(this.defaults.rvcEnhancementVoiceId);
  readonly rvcIndexRate = signal(this.defaults.rvcEnhancementIndexRate);
  readonly rvcProtectRate = signal(this.defaults.rvcEnhancementProtectRate);
  readonly rvcNSemitones = signal(this.defaults.rvcEnhancementNSemitones);
  /**
   * '' IS "let the converter choose" and is a real answer, not a blank.
   *
   * The two engine-default settings are spelled as a sentinel here rather than
   * as `string | undefined` because they are bound to button groups, where the
   * "no choice" option has to be as clickable as the others — a control you can
   * only leave alone is not a control. They are turned back into absence at
   * submission, which is the only shape the run description accepts.
   */
  readonly rvcF0Method = signal<string>(this.defaults.rvcEnhancementF0Method ?? '');
  /** 0 is the same sentinel for the hop; the engine's own range starts at 1. */
  readonly rvcHopLength = signal<number>(this.defaults.rvcEnhancementHopLength ?? 0);

  readonly submitting = signal(false);
  /** The refusal from the last submission, the builder's or main's, verbatim. */
  readonly error = signal<string | null>(null);

  readonly namingPreset = signal(false);
  readonly presetName = signal('');

  /**
   * The sentences this project already has, or null. Looked up when the dialog
   * opens, from the SAME call the cache-only queue steps make.
   *
   * A failure to look it up leaves this null and the cache-only stages refused
   * with a sentence — which is the safe way to be wrong about a question whose
   * true answer would authorise spending GPU on files nobody has seen.
   */
  readonly cachedSentences = signal<CachedSentences | null>(null);

  /** Only a PART-finished render is something to resume; a complete one is not. */
  readonly resumable = computed(() => {
    const cached = this.cachedSentences();
    return cached !== null && !cached.complete ? cached : null;
  });

  /**
   * Carry on, or start over. Defaults to carrying on — the cached sentences are
   * hours of GPU, and the case where they are stale is the one the user knows
   * about and can say so.
   */
  readonly resumeChoice = signal<'resume' | 'fresh'>('resume');

  // ── The assembly gap, resolved from the session's own provenance ──────────
  readonly showGap = signal(false);
  readonly sentenceGap = signal(0.6);
  readonly gapHasModel = signal(false);
  readonly gapVoice = signal('This voice');
  /** True once the user has moved the gap slider — see `onSubmit`. */
  private readonly gapTouched = signal(false);

  constructor() {
    // The catalog is the machine's, loaded once per app; asking again is free.
    void this.voices.load();

    effect(() => {
      const dir = this.projectDir();
      this.cachedSentences.set(null);
      this.resumeChoice.set('resume');
      this.showGap.set(false);
      this.gapTouched.set(false);
      if (!dir) return;
      void this.loadCachedSentences(dir);
    });
  }

  /**
   * MOVING THE SLIDER IS WHAT STATES A GAP.
   *
   * The field opens pre-filled from the session's provenance, and that pre-fill
   * is a display of the answer the assembler would reach on its own. Sending it
   * back would freeze a living value into a copy of what it was when the dialog
   * opened — so the run carries a gap only once somebody has actually chosen
   * one, and this is the gesture that says they did.
   */
  onSentenceGapInput(value: number): void {
    this.sentenceGap.set(value);
    this.gapTouched.set(true);
  }

  /**
   * Ask main what this project has rendered, and what gap its session implies.
   *
   * Silent on failure: both answers are OFFERS. Without the first the
   * cache-only stages stay refused (with a sentence saying why), and without
   * the second the gap field is simply not drawn, which is exactly what a
   * non-Orpheus session gets anyway.
   */
  private async loadCachedSentences(dir: string): Promise<void> {
    const bridge = (window as unknown as {
      electron?: {
        reassembly?: {
          getBfpSession?: (d: string) => Promise<{
            success: boolean;
            data?: {
              processDir?: string;
              totalSentences?: number;
              completedSentences?: number;
              metadata?: { language?: string };
              provenance?: { voice?: string };
            } | null;
          }>;
        };
      };
    }).electron;
    const ask = bridge?.reassembly?.getBfpSession;
    if (!ask) return;
    try {
      const res = await ask(dir);
      if (this.projectDir() !== dir) return;   // the dialog moved on
      const data = res.success ? res.data : null;
      if (!data || !data.processDir || !data.totalSentences) return;
      const completed = data.completedSentences ?? 0;
      this.cachedSentences.set({
        processDir: data.processDir,
        language: data.metadata?.language ?? 'en',
        completedSentences: completed,
        totalSentences: data.totalSentences,
        complete: completed >= data.totalSentences,
        ...(data.provenance?.voice ? { voice: data.provenance.voice } : {}),
      });
      await this.loadSentenceGap(data.processDir, dir);
    } catch { /* silent: an offer that cannot be made is simply not made */ }
  }

  /** The session's own inter-sentence gap, when its provenance names one. */
  private async loadSentenceGap(processDir: string, dir: string): Promise<void> {
    try {
      const res = await this.electron.resolveSentenceGap(processDir);
      if (this.projectDir() !== dir) return;
      if (!res.success || !res.data || !res.data.isOrpheus) return;
      this.sentenceGap.set(res.data.gap);
      this.gapHasModel.set(res.data.hasModelValue);
      this.gapVoice.set(res.data.voice ?? 'This voice');
      this.showGap.set(true);
      // Setting the field is not the user stating a value.
      this.gapTouched.set(false);
    } catch { /* the field is simply not drawn */ }
  }

  readonly fileLabel = computed(() => fileName(this.epubPath()));

  /** What each engine can do — worker ceiling, which sampling knobs are real. */
  private readonly caps = computed(() => engineCaps(this.engine()));

  readonly engineDisplayName = computed(() =>
    this.engines().find((e) => e.id === this.engine())?.displayName ?? this.engine());

  readonly maxWorkers = computed(() =>
    this.workerCfg.enabled() ? this.caps().maxWorkers : 1);

  readonly showsSampling = computed(() => {
    const s = this.caps().sampling;
    return !!(s.temperature || s.topP || s.repetitionPenalty);
  });

  readonly voiceOptions = computed<DesktopSelectItems>(() =>
    this.voices.voicesFor(this.engine()).map((v) => ({ value: v.value, label: v.label })));

  readonly rvcInstalled = computed(() => this.components.isInstalled('rvc-env'));
  readonly rvcVoiceOptions = computed<DesktopSelectItems>(() =>
    this.voices.rvcVoices().map((v) => ({ value: v.value, label: v.label })));

  /** The hop is read only by the crepe family; beside RMVPE it is inert. */
  readonly hopApplies = computed(() => CREPE_FAMILY.has(this.rvcF0Method()));

  /** Protection stated as what it DOES, since the number reads backwards. */
  readonly protectLabel = computed(() => {
    const rate = this.rvcProtectRate();
    if (rate >= 0.5) return 'off (0.5)';
    return `${rate}`;
  });

  // ── Presets ───────────────────────────────────────────────────────────────

  private readonly presets = signal<PipelinePreset[]>(this.settings.getPipelinePresets());

  readonly presetOptions = computed<DesktopSelectItems>(() => [
    { value: '', label: 'No preset' },
    ...this.presets().map((p) => ({ value: p.id, label: p.name })),
  ]);

  /**
   * The preset whose every value the controls currently hold, or ''.
   *
   * Derived rather than remembered: a preset that is "selected" while a control
   * beside it has been moved is a label claiming a tuning nobody is running.
   */
  readonly activePresetId = computed(() => {
    const match = this.presets().find((p) =>
      p.ttsEngine === this.engine()
      && p.ttsVoice === this.voice()
      && p.ttsSpeed === this.speed()
      && p.ttsTemperature === this.temperature()
      && p.ttsTopP === this.topP()
      && p.ttsRepetitionPenalty === this.repetitionPenalty()
      && p.rvcEnhancementEnabled === this.rvc()
      && p.rvcEnhancementVoiceId === this.rvcVoiceId()
      && p.rvcEnhancementIndexRate === this.rvcIndexRate()
      && p.rvcEnhancementProtectRate === this.rvcProtectRate()
      && p.rvcEnhancementNSemitones === this.rvcNSemitones()
      && (p.rvcEnhancementF0Method ?? '') === this.rvcF0Method()
      && (p.rvcEnhancementHopLength ?? 0) === this.rvcHopLength());
    return match ? match.id : '';
  });

  /**
   * Apply a preset to the WHOLE run, reading tab included.
   *
   * A preset is a VOICE PAIR — the reading voice and the conversion that was
   * auditioned against it — so applying only its rates would leave the user
   * running half of a tuning nobody tested, under that tuning's name. It also
   * turns the conversion stage on or off, because whether there IS a conversion
   * is part of what the preset says.
   */
  applyPreset(id: string): void {
    if (!id) return;
    const preset = this.presets().find((p) => p.id === id);
    if (!preset) return;
    this.engine.set(preset.ttsEngine);
    this.voice.set(preset.ttsVoice);
    this.device.set(preset.ttsDevice);
    this.speed.set(preset.ttsSpeed);
    this.temperature.set(preset.ttsTemperature);
    this.topP.set(preset.ttsTopP);
    this.repetitionPenalty.set(preset.ttsRepetitionPenalty);
    this.rvc.set(preset.rvcEnhancementEnabled);
    this.rvcVoiceId.set(preset.rvcEnhancementVoiceId);
    this.rvcIndexRate.set(preset.rvcEnhancementIndexRate);
    this.rvcProtectRate.set(preset.rvcEnhancementProtectRate);
    this.rvcNSemitones.set(preset.rvcEnhancementNSemitones);
    this.rvcF0Method.set(preset.rvcEnhancementF0Method ?? '');
    this.rvcHopLength.set(preset.rvcEnhancementHopLength ?? 0);
  }

  /** Save the controls as they stand under a name the user typed. */
  savePreset(): void {
    const name = this.presetName().trim();
    if (!name) return;
    const next = this.settings.savePipelinePreset({
      id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      ttsEngine: this.engine(),
      ttsDevice: this.device(),
      ttsVoice: this.voice(),
      ttsSpeed: this.speed(),
      ttsTemperature: this.temperature(),
      ttsTopP: this.topP(),
      ttsRepetitionPenalty: this.repetitionPenalty(),
      rvcEnhancementEnabled: this.rvc(),
      rvcEnhancementVoiceId: this.rvcVoiceId(),
      rvcEnhancementIndexRate: this.rvcIndexRate(),
      rvcEnhancementProtectRate: this.rvcProtectRate(),
      rvcEnhancementNSemitones: this.rvcNSemitones(),
      // Absent when the run leaves the choice to the converter, so the preset
      // records "engine default" rather than freezing whatever it is today.
      ...(this.rvcF0Method() ? { rvcEnhancementF0Method: this.rvcF0Method() } : {}),
      ...(this.rvcHopLength() ? { rvcEnhancementHopLength: this.rvcHopLength() } : {}),
    });
    this.presets.set(next);
    this.namingPreset.set(false);
    this.presetName.set('');
  }

  selectEngine(id: TTSEngine): void {
    this.engine.set(id);
    // A voice belongs to an engine. Keeping the old one across a change would
    // send Orpheus an XTTS reference clip, which fails inside the job rather
    // than here — so the first voice this engine HAS is selected instead.
    const available = this.voices.voicesFor(id);
    if (!available.some((v) => v.value === this.voice())) {
      const first = available[0];
      this.voice.set(first ? first.value : '');
    }
  }

  // ── What this run will do, and what stops it ──────────────────────────────

  /**
   * ONE PLAIN SENTENCE saying what happens and what is left behind.
   *
   * The most important thing it says is WHERE THE AUDIO LANDS, because the two
   * answers are opposite and neither is guessable from the toggles: a run that
   * narrates replaces this book's audiobook, and a run that only converts
   * cached sentences adds a version beside it.
   */
  readonly runSentence = computed(() => {
    const acts: string[] = [];
    if (this.narrate()) acts.push(`reads the book with ${this.voice() || 'the chosen voice'}`);
    if (this.rvc()) {
      acts.push(`${this.narrate() ? 'converts the sentences' : 'converts the cached sentences'} `
        + `through ${this.voices.rvcVoiceLabel(this.rvcVoiceId()) || 'an RVC voice'}`);
    }
    if (!this.narrate() && !this.rvc() && this.assemble()) {
      acts.push('reassembles the sentences already rendered for this book');
    }
    const doing = acts.join(', then ');
    if (!this.assemble()) {
      return `This run ${doing} and stops there, leaving the rendered sentences cached and no `
        + 'audiobook. Turn on Assemble to get one.';
    }
    const lands = this.rvc() && !this.narrate()
      ? `adds a NEW version of the audiobook — ${
        this.voices.rvcVoiceLabel(this.rvcVoiceId()) || 'the conversion voice'
      } — beside the one this book already has`
      : "replaces this book's audiobook";
    return `This run ${doing}, assembles the result, and ${lands}.`;
  });

  /**
   * Why the chosen stages cannot be run, or null.
   *
   * The two impossible shapes are refused HERE, on screen, rather than by
   * bouncing a toggle: a control that undoes itself when clicked tells the user
   * nothing about why.
   */
  readonly stageRefusal = computed<string | null>(() => {
    if (!this.narrate() && !this.rvc() && !this.assemble()) {
      return 'Nothing is selected, so there is nothing to queue. Choose at least one of the '
        + 'three above.';
    }
    if (this.rvc() && !this.assemble()) {
      return 'Converting the sentences without assembling them would spend the whole conversion '
        + 'on a scratch folder that is deleted straight afterwards, leaving nothing to listen '
        + 'to. Turn on Assemble as well.';
    }
    if (!this.narrate() && this.cachedSentences() === null) {
      return 'This book has no rendered sentences on disk, so there is nothing to convert or '
        + 'assemble. Turn on Narrate to read it first.';
    }
    if (this.rvc() && !this.rvcInstalled()) {
      return this.rvcUnavailableNote;
    }
    if (this.rvc() && !this.rvcVoiceId()) {
      return 'No conversion voice is chosen, so there is nothing to re-render the sentences '
        + 'through. Pick one on the Voice conversion tab.';
    }
    if (this.narrate() && !this.voice()) {
      return 'No voice is selected, so this run would be rendered in whatever voice the queue '
        + 'happened to default to. Pick one on the Reading tab.';
    }
    return null;
  });

  /**
   * Why this dialog cannot queue anything AT ALL, or null.
   *
   * These are facts about the book rather than about the choices, so they
   * replace the whole form instead of sitting under it.
   */
  readonly refusal = computed<string | null>(() => {
    if (!this.epubPath()) {
      return 'The button did not name a file, so there is nothing to narrate. This is a bug in '
        + 'the page that opened this dialog.';
    }
    // The file is handed over already proved to be on disk; what this side can
    // still say is whether it is a BOOK. An M4B or a PDF reaching here would be
    // queued and would fail an hour later inside the TTS job, naming a path the
    // user cannot place.
    if (!/\.epub$/i.test(this.epubPath())) {
      return `${this.fileLabel()} is not an EPUB, so it cannot be narrated. Narration reads a `
        + 'book; start this from an EPUB version of it.';
    }
    if (!this.variantId()) {
      return 'The button did not say which version of the book this file is, so the run could '
        + 'not be filed against one. This is a bug in the page that opened this dialog.';
    }
    if (!this.projectDir()) {
      return 'This book has no project directory, so there is nowhere to put the rendered '
        + 'sentences or the finished audiobook.';
    }
    if (!this.library.audiobooksPath()) {
      return 'No audiobooks folder is set, so there is nowhere to file the finished audiobook. '
        + 'Set one in Settings.';
    }
    return null;
  });

  readonly submitDisabled = computed(() =>
    this.submitting() || this.refusal() !== null || this.stageRefusal() !== null);

  onCancel(): void {
    if (this.submitting()) return;
    this.cancelled.emit();
  }

  /**
   * Build the run and queue it — nothing runs here.
   *
   * Everything that can fail is in `buildNarrationJobs`, which throws with
   * nothing built rather than emitting a request with a hole in it: a workflow
   * half in the queue cannot be retried without double-queueing it.
   */
  async onSubmit(): Promise<void> {
    if (this.submitDisabled()) return;
    this.error.set(null);
    this.submitting.set(true);
    try {
      const book: NarrationRunBook = {
        epubPath: this.epubPath(),
        projectDir: this.projectDir(),
        variantId: this.variantId(),
        title: this.title(),
        author: this.author(),
        year: this.year(),
        coverPath: this.coverPath(),
        outputFilename: this.outputFilename(),
        isArticle: this.isArticle(),
      };
      const settings: NarrationRunSettings = {
        // Narration reads the book in the book's own language, which is what the
        // TTS bridge detects from the file it is given. 'en' is this dialog's
        // one stated assumption and the same one the queue's config carries.
        language: 'en',
        ttsEngine: this.engine(),
        voice: this.voice(),
        device: this.device(),
        temperature: this.temperature(),
        topP: this.topP(),
        repetitionPenalty: this.repetitionPenalty(),
        speed: this.speed(),
        workers: this.maxWorkers() > 1 ? this.workers() : 1,
        // Non-null by `refusal()`, which `submitDisabled` gates on: a run with
        // nowhere to file the audiobook is refused on screen rather than queued
        // with an empty output folder.
        outputDir: this.library.audiobooksPath()!,
        finalDenoise: this.finalDenoise(),
        applyDeRing: this.applyDeRing(),
        /*
         * SENT ONLY WHEN THE USER MOVED IT. Absent means the session's own
         * provenance decides the gap — the voice's tuned value — and sending the
         * number the field was PRE-FILLED with would turn that living answer
         * into a frozen copy of what it happened to be when the dialog opened.
         */
        ...(this.showGap() && this.gapTouched() ? { sentenceGap: this.sentenceGap() } : {}),
        rvc: this.rvc()
          ? {
              voiceId: this.rvcVoiceId(),
              indexRate: this.rvcIndexRate(),
              protectRate: this.rvcProtectRate(),
              nSemitones: this.rvcNSemitones(),
              // The sentinels turn back into absence, which is the only way to
              // say "urvc's own default" to the run description.
              ...(this.rvcF0Method() ? { f0Method: this.rvcF0Method() } : {}),
              ...(this.rvcHopLength() && this.hopApplies()
                ? { hopLength: this.rvcHopLength() }
                : {}),
            }
          : null,
        /*
         * Only ever true when the user was SHOWN the choice and took it. With
         * no part-finished render this stays false: `true` authorises deleting
         * scratch checkpoints, and sending it unasked would throw away an hour
         * of GPU nobody mentioned.
         */
        startFresh: this.resumable() !== null && this.resumeChoice() === 'fresh',
      };

      const jobs = buildNarrationJobs(book, settings, {
        narrate: this.narrate(),
        rvc: this.rvc(),
        assemble: this.assemble(),
      });

      const workflowId = `tts-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const master = await this.queue.addJob({
        type: 'audiobook',
        epubPath: book.epubPath,
        variantId: book.variantId,
        ...(book.isArticle ? { projectDir: book.projectDir } : { bfpPath: book.projectDir }),
        metadata: { title: book.title, author: book.author },
        config: { type: 'audiobook' },
        workflowId,
      });
      for (const job of jobs) {
        await this.queue.addJob({ ...job, workflowId, parentJobId: master.id });
      }
      this.queued.emit({ jobs: jobs.length });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.submitting.set(false);
    }
  }
}
