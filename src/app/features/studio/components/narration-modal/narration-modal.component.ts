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
 * how it is READ, how it is ENHANCED, how it is ASSEMBLED — and a single column
 * of twenty controls was what Owen called ugly.
 *
 * ── THE TAB STRIP IS THE RUN PLAN ───────────────────────────────────────────
 *
 * Owen, 2026-08-27: *"put the tabs along the top of the modal"* with *"a
 * checkbox/checkbutton on each tab item, so the user can check the checkbox if
 * they want to run that step."* So the three stages are no longer a row of
 * toggles ABOVE a row of tabs saying the same three words — each tab carries
 * its own check, and the strip states the whole run at a glance.
 *
 * Checking is not selecting. The tab NAME opens that stage's settings; the
 * CHECK decides whether the stage runs. A tab can be open and unchecked (you
 * are reading its settings) or checked and closed (it runs, you are looking
 * elsewhere), and both are drawn so neither is a surprise.
 *
 * The run description still takes the three as three
 * (shared/queue/narration-run.ts). The combinations that are not runs are
 * refused ON SCREEN in a sentence rather than prevented by moving a check the
 * user did not touch, so nobody has to work out why the thing they clicked
 * bounced.
 *
 * ── ONE OF THE THREE CHECKS NOW COVERS TWO PASSES ───────────────────────────
 *
 * Owen, 2026-08-29: the final denoise left the Assembly tab, because it *"is not
 * a casual click — it takes real GPU work"*, the same as the voice conversion.
 * The tab that held the conversion holds both and is called **Enhance**; inside
 * it are two labelled sections with an enable each — **Denoise** and **Voice
 * conversion (RVC)** — and, when both are on, the ORDER, which is the user's to
 * pick (default denoise-first, because noise corrupts RVC's f0/content
 * extraction and the roformer is proven to leave clean audio unchanged).
 *
 * ITS CHECK THEREFORE MEANS "AT LEAST ONE ENHANCEMENT PASS RUNS", which is the
 * same grammar the other two checks have: the stage happens, and what it consists
 * of is answered by the settings on the tab. Checking it with neither pass turned
 * on turns the DENOISE on, because that is the pass with nothing left to choose;
 * unchecking it stops both without erasing either, so a conversion tuned by ear
 * survives being turned off and on again — checking is still not selecting.
 *
 * The tab is not called "Voice conversion" any more because that named one of the
 * two things behind it, and RVC is named INSIDE, on the section that is actually
 * the tool: two GPU passes on one page have to be told apart.
 *
 * The one-sentence run summary that sat here is GONE on the same ruling
 * (*"remove the run-sentence line entirely"*): with the plan legible on the
 * strip it was a paraphrase of three checkboxes.
 *
 * ── AND THE DOOR DECIDES WHAT MAY BE CHECKED ────────────────────────────────
 *
 * `context` says which door was pressed (NarrationDialogService). From the
 * sentence-cache row the Reading tab is locked off, because a fresh read is a
 * thing you start from the book. It is required, with no default, at every
 * step of the way here.
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
import type { CreateJobRequest } from '../../../queue/models/queue.types';
import { NarrationVoicesService } from '../../../queue/jobs/narration-voices.service';
import {
  buildNarrationJobs,
  type NarrationEnhancementOrder,
  type NarrationRunBook,
  type NarrationRunSettings,
} from '../../../queue/jobs/narration-run';
import { narrationVideoStep, type VideoResolution } from '@shared/queue/narration-video';
import {
  engineCaps, selectableEngines, isRunnableTtsEngine, TTS_ENGINES,
} from '../../../../core/models/tts-engine-registry';
import type { NarrationEntryContext } from '../../services/narration-dialog.service';
import type { TTSEngine } from '@shared/tts/engine-caps';

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

/** Which tab is showing. `'enhance'` holds BOTH GPU passes — see the header. */
type NarrationTab = 'tts' | 'assembly' | 'enhance';

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

/**
 * THE LANGUAGE THIS DIALOG STATES, in one place.
 *
 * Narration reads the book in the book's own language, which is what the TTS
 * bridge detects from the file it is given; this is the dialog's one stated
 * assumption and the same one the queue's config carries. The video job is
 * given the SAME answer — its subtitles are the narration's — because two
 * literals would be two chances for a run and its video to disagree about what
 * language they are in.
 */
const RUN_LANGUAGE = 'en';

/**
 * The video sizes the renderer offers — the Process wizard's three, verbatim.
 *
 * They are the ones `VideoAssemblyJobConfig.resolution` accepts, so the list is
 * the type's own set rather than a taste about sizes.
 */
const VIDEO_RESOLUTIONS: ReadonlyArray<{
  value: VideoResolution; label: string; pixels: string;
}> = [
  { value: '480p', label: '480p', pixels: '854 × 480' },
  { value: '720p', label: '720p', pixels: '1280 × 720' },
  { value: '1080p', label: '1080p', pixels: '1920 × 1080' },
];

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

          <!-- ── The tab strip IS the run plan ───────────────────────────
               Each tab carries its own check, and the three checks together are
               the whole of what this run will do. Checking is not selecting:
               the NAME opens that stage's settings, the CHECK decides whether
               the stage runs, and both are legible at once so the plan can be
               read off the strip without opening anything. -->
          <nav class="nm-tabs" role="tablist">
            <div class="nm-tab" [class.on]="tab() === 'tts'" [class.run]="narrate()">
              <input type="checkbox" class="nm-tab-check"
                     aria-label="Read the book aloud in this run"
                     [checked]="narrate()"
                     [disabled]="narrateLocked()"
                     [title]="narrateCheckNote()"
                     (change)="narrate.set($any($event.target).checked)" />
              <button type="button" role="tab" class="nm-tab-name"
                      [attr.aria-selected]="tab() === 'tts'"
                      [disabled]="narrateLocked()"
                      [title]="narrateCheckNote()"
                      (click)="tab.set('tts')">Reading</button>
            </div>
            <!-- ONE CHECK, TWO PASSES. It means "at least one enhancement pass
                 runs"; which of them is answered inside. It is NOT disabled when
                 the conversion engine is missing, because the denoise does not
                 need it — only that section is. -->
            <div class="nm-tab" [class.on]="tab() === 'enhance'" [class.run]="enhance()">
              <input type="checkbox" class="nm-tab-check"
                     aria-label="Run at least one enhancement pass over the sentences"
                     [checked]="enhance()"
                     title="Denoise the sentences, convert them through an RVC voice, or both"
                     (change)="onEnhanceToggled($any($event.target).checked)" />
              <button type="button" role="tab" class="nm-tab-name"
                      [attr.aria-selected]="tab() === 'enhance'"
                      (click)="tab.set('enhance')">Enhance</button>
            </div>
            <div class="nm-tab" [class.on]="tab() === 'assembly'" [class.run]="assemble()">
              <input type="checkbox" class="nm-tab-check"
                     aria-label="Combine the sentences into an M4B"
                     [checked]="assemble()"
                     title="Combine the sentences into an M4B"
                     (change)="assemble.set($any($event.target).checked)" />
              <button type="button" role="tab" class="nm-tab-name"
                      [attr.aria-selected]="tab() === 'assembly'"
                      (click)="tab.set('assembly')">Assembly</button>
            </div>
          </nav>

          @if (narrateLocked()) {
            <p class="nm-locked">{{ narrateLockedNote }}</p>
          }

          @if (stageRefusal(); as why) {
            <p class="nm-plan bad">{{ why }}</p>
          }

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

              <!-- The sampling trio was the ENGINE's, not the dialog's, and both
                   engines this build renders in fix theirs inside the engine
                   class. The three sliders drew for XTTS alone and went with it
                   on 2026-09-05; what is left is the sentence saying so. -->
              <p class="nm-hint">
                {{ engineDisplayName() }} sets its own temperature, top-p and repetition
                penalty inside the engine, so there is nothing here to move.
              </p>
            }

            <!-- ── Enhance: two GPU passes, and their order ─────────────── -->
            @if (tab() === 'enhance') {
              @if (!enhance()) {
                <p class="nm-hint">
                  This run enhances nothing — it assembles the sentences as they were
                  rendered. Tick this tab's checkbox to run a pass; turning one on below
                  ticks it for you.
                </p>
              }

              <!-- ── Pass one: the denoise ──────────────────────────────
                   First because it is the recommended first pass and the one
                   that needs no choice beyond yes. -->
              <div class="nm-field nm-pass">
                <label class="nm-check">
                  <input type="checkbox" [checked]="finalDenoise()"
                         (change)="onDenoiseToggled($any($event.target).checked)" />
                  <span class="nm-pass-name">Denoise</span>
                </label>
                <span class="nm-hint">
                  Strips the faint hiss bed the voice model was trained on, once, over
                  the whole book — a roformer pass on the GPU, about as long as the
                  narration itself. Its result is kept in the session, so assembling the
                  book again does not pay for it twice.
                </span>
              </div>

              <!-- ── Pass two: the conversion ─────────────────────────── -->
              <div class="nm-field nm-pass">
                <label class="nm-check">
                  <input type="checkbox" [checked]="rvcEnabled()"
                         [disabled]="!rvcInstalled()"
                         [title]="rvcInstalled() ? '' : rvcUnavailableNote"
                         (change)="onRvcToggled($any($event.target).checked)" />
                  <span class="nm-pass-name">Voice conversion (RVC)</span>
                </label>
                <span class="nm-hint">
                  Re-renders every sentence through a second voice model, so the book is
                  read in that voice. Also GPU, also about a narration's worth of it.
                </span>
              </div>

              <!-- ── WHICH GOES FIRST, when both do ──────────────────────
                   Only asked when there are two passes to order. Owen's ruling:
                   both together stay allowed and the ORDER is the user's. The
                   default says WHY it is the default; the reverse is offered
                   without an argument for it, because it is a right rather than
                   a recommendation. -->
              @if (finalDenoise() && rvcEnabled()) {
                <div class="nm-field nm-order">
                  <label class="nm-label">Order</label>
                  <label class="nm-check">
                    <input type="radio" name="nm-enhance-order"
                           [checked]="enhancementOrder() === 'denoise-first'"
                           (change)="enhancementOrder.set('denoise-first')" />
                    <span>Denoise first, then convert <em>(recommended — noise degrades
                    conversion)</em></span>
                  </label>
                  <label class="nm-check">
                    <input type="radio" name="nm-enhance-order"
                           [checked]="enhancementOrder() === 'rvc-first'"
                           (change)="enhancementOrder.set('rvc-first')" />
                    <span>Convert first, then denoise</span>
                  </label>
                  <span class="nm-hint">
                    The conversion reads pitch and content out of whatever it is handed,
                    and noise corrupts that reading; the denoise is measured to leave
                    already-clean audio unchanged. So denoising first cannot make the
                    conversion worse, which is why it is the default — not because the
                    other order is wrong.
                  </span>
                </div>
              }

              @if (!rvcInstalled()) {
                <p class="nm-hint">{{ rvcUnavailableNote }}</p>
              } @else {
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
                    [disabled]="!rvcEnabled()"
                    [ngModel]="rvcVoiceId()"
                    (ngModelChange)="rvcVoiceId.set($event)"
                  />
                </div>

                <div class="nm-field">
                  <label class="nm-label">Pitch extraction</label>
                  <div class="nm-choices">
                    <button type="button" class="nm-choice" [class.on]="rvcF0Method() === ''"
                            [disabled]="!rvcEnabled()"
                            (click)="rvcF0Method.set('')">Engine default</button>
                    @for (m of f0Methods; track m.value) {
                      <button type="button" class="nm-choice"
                              [class.on]="rvcF0Method() === m.value"
                              [disabled]="!rvcEnabled()"
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
                         [disabled]="!rvcEnabled() || !hopApplies()"
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
                         [disabled]="!rvcEnabled()"
                         [value]="rvcNSemitones()"
                         (input)="rvcNSemitones.set(+$any($event.target).value)" />
                </div>

                <div class="nm-field">
                  <label class="nm-label">Index rate: {{ rvcIndexRate() }}</label>
                  <input type="range" class="nm-slider" min="0" max="1" step="0.05"
                         [disabled]="!rvcEnabled()"
                         [value]="rvcIndexRate()"
                         (input)="rvcIndexRate.set(+$any($event.target).value)" />
                  <span class="nm-hint">How far the conversion leans on the model's timbre index.</span>
                </div>

                <div class="nm-field">
                  <label class="nm-label">
                    Consonant protection: {{ protectLabel() }}
                  </label>
                  <input type="range" class="nm-slider" min="0" max="0.5" step="0.05"
                         [disabled]="!rvcEnabled()"
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
              <!-- THE DENOISE IS NOT HERE ANY MORE (Owen, 2026-08-29): it is an
                   hour of GPU over the book, which is not the kind of thing an
                   assembly checkbox should look like. It lives on the Enhance
                   tab beside the conversion, where both GPU passes are chosen and
                   ordered together. What is left here is de-ring, which is an
                   ffmpeg filter at the final encode and belongs to the encode. -->
              <div class="nm-field">
                <label class="nm-check">
                  <input type="checkbox" [checked]="applyDeRing()" [disabled]="!assemble()"
                         (change)="applyDeRing.set($any($event.target).checked)" />
                  <span>Remove ringing</span>
                </label>
              </div>

              <!-- THE VIDEO, made FROM the m4b this tab produces.
                   The one capability the Process wizard had that lives nowhere
                   else, ported here when that page was erased. It is drawn on
                   this tab because it is a second OUTPUT of the assembly, not a
                   stage of its own: without an assembly there is no file to
                   render a video from, which is why it is refused rather than
                   silently dropped when Assembly is unchecked. -->
              <div class="nm-field">
                <label class="nm-check">
                  <input type="checkbox" [checked]="video()" [disabled]="!assemble()"
                         (change)="video.set($any($event.target).checked)" />
                  <span>Also produce a video</span>
                </label>
                <span class="nm-hint">
                  An MP4 of the finished audiobook with its subtitles burned in, made
                  after the M4B and beside it.
                </span>
              </div>

              @if (video()) {
                <div class="nm-field">
                  <label class="nm-label">Video resolution</label>
                  <div class="nm-choices">
                    @for (r of videoResolutions; track r.value) {
                      <button type="button" class="nm-choice"
                              [class.on]="videoResolution() === r.value"
                              [disabled]="!assemble()"
                              [title]="r.pixels"
                              (click)="videoResolution.set(r.value)">{{ r.label }}</button>
                    }
                  </div>
                </div>
              }

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

    /* One plain sentence, drawn only to refuse a plan that is not a run. */
    .nm-plan {
      margin: 12px 0 0; padding: 9px 11px; border-radius: 8px;
      font-size: 0.76rem; line-height: 1.5;
      background: var(--bg-base); color: var(--text-secondary);
      border-left: 3px solid var(--accent-primary, #06b6d4);
    }
    .nm-plan.bad { border-left-color: var(--accent-danger, #ef4444); color: var(--text-primary); }

    /* The strip sits at the top because it is the run plan, not navigation:
       what is CHECKED here is what will happen, and the checks are drawn at
       equal weight so all three read at a glance. */
    .nm-tabs {
      display: flex; gap: 2px; margin-top: 16px;
      border-bottom: 1px solid var(--border-default, rgba(255,255,255,0.12));
    }
    .nm-tab {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 12px 8px; border-bottom: 2px solid transparent;
      margin-bottom: -1px; border-radius: 7px 7px 0 0;
    }
    /* CHECKED, not selected: a tab whose stage runs is tinted whether or not it
       is the tab on show, so the plan survives looking at another tab. */
    .nm-tab.run { background: var(--selected-bg-muted, rgba(6,182,212,0.1)); }
    .nm-tab.on { border-bottom-color: var(--accent-primary, #06b6d4); }
    .nm-tab-check { margin: 0; cursor: pointer; accent-color: var(--accent-primary, #06b6d4); }
    .nm-tab-check:disabled { cursor: not-allowed; opacity: 0.4; }
    .nm-tab-name {
      padding: 0; border: none; background: none; cursor: pointer;
      font-family: inherit; font-size: 0.78rem; font-weight: 600;
      color: var(--text-tertiary);
    }
    .nm-tab-name:hover:not(:disabled) { color: var(--text-secondary); }
    .nm-tab.on .nm-tab-name { color: var(--text-primary); }
    .nm-tab-name:disabled { cursor: not-allowed; opacity: 0.45; }
    /* The locked Reading tab says WHY in a line of its own: a disabled control
       whose reason lives in a tooltip is a reason nobody reads. */
    .nm-locked {
      margin: 10px 0 0; padding: 8px 11px; border-radius: 8px;
      font-size: 0.74rem; line-height: 1.5;
      background: var(--bg-base); color: var(--text-secondary);
      border-left: 3px solid var(--border-subtle, rgba(128,128,128,0.4));
    }

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
    /* Two GPU passes on one page, each in a box of its own so neither reads as a
       sub-option of the other — they are siblings, and the user usually wants
       one of them. */
    .nm-pass {
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border-subtle, rgba(128,128,128,0.28));
      background: rgba(128,128,128,0.06);
    }
    .nm-pass-name { font-weight: 600; }
    /* The order question only exists when both passes do, so it is drawn as part
       of the pair rather than as a third setting. */
    .nm-order {
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--accent-primary, #06b6d4);
      background: var(--selected-bg-muted, rgba(6,182,212,0.08));
    }
    .nm-order .nm-check { align-items: flex-start; line-height: 1.45; }
    .nm-order em { font-style: normal; color: var(--text-secondary); }
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
  /**
   * WHICH DOOR opened this — see `NarrationEntryContext`.
   *
   * `required` and never defaulted: it decides whether this run is allowed to
   * read the book at all, and a door that forgot to say would silently get the
   * one this input happened to be written with.
   */
  readonly context = input.required<NarrationEntryContext>();
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

  /**
   * The run plan each door opens with — the ONE statement of both.
   *
   * The cache door's plan is "assemble what is there": reading is locked off
   * (it is what the door means), and enhancement starts OFF because an hour of
   * GPU is a thing the user asks for by checking it, not something a press on a
   * folder icon should have already decided.
   */
  private entryPlan(context: NarrationEntryContext): {
    tab: NarrationTab; narrate: boolean; enhance: boolean;
    denoise: boolean; convert: boolean; assemble: boolean;
  } {
    /*
     * THE STAGE AND ITS PASSES ARE STATED TOGETHER, because a plan that set one
     * without the other could open with a pass ticked inside an unticked stage —
     * a screen that says two things about whether the conversion runs.
     *
     * The saved default is about the CONVERSION, which is one of the two passes,
     * so it answers both: whether that pass is on, and therefore whether the
     * stage is. The denoise starts off in both doors — it is GPU hours, and a
     * run nobody asked to denoise must not.
     */
    return context === 'cache'
      ? {
          tab: 'assembly', narrate: false,
          enhance: false, denoise: false, convert: false, assemble: true,
        }
      : {
          tab: 'tts', narrate: true,
          enhance: this.defaults.rvcEnhancementEnabled,
          denoise: false,
          convert: this.defaults.rvcEnhancementEnabled,
          assemble: true,
        };
  }

  /*
   * Constructed with the DOCUMENT door's plan because a required input cannot
   * be read from a field initialiser — the effect in the constructor re-seeds
   * these from the real door the moment it can, and again if a second press
   * replaces the target (Foundry's Narrate, while this is already open).
   */
  private readonly openingPlan = this.entryPlan('document');

  readonly tab = signal<NarrationTab>(this.openingPlan.tab);

  readonly narrate = signal(this.openingPlan.narrate);
  /** THE STAGE: at least one enhancement pass runs. Which ones is `finalDenoise`
   *  and `rvcEnabled` below — see the header. */
  readonly enhance = signal(this.openingPlan.enhance);
  readonly assemble = signal(this.openingPlan.assemble);

  readonly engine = signal<TTSEngine>(this.defaults.ttsEngine);
  readonly voice = signal<string>(this.defaults.ttsVoice);
  readonly device = signal<'auto' | 'gpu' | 'mps' | 'cpu'>(this.defaults.ttsDevice);
  readonly speed = signal(this.defaults.ttsSpeed);
  readonly workers = signal(1);

  /**
   * PASS ONE of the enhancement stage — the roformer denoise.
   *
   * It was an Assembly-tab checkbox until 2026-08-29. Same signal, same default
   * (off — it is GPU hours, and a run nobody asked to denoise must not), drawn
   * on the Enhance tab beside the pass it is ordered against.
   */
  readonly finalDenoise = signal(this.openingPlan.denoise);
  /**
   * PASS TWO — the voice conversion. Seeded from Pipeline Defaults through the
   * same entry plan the stage flag is, because they are the same saved answer
   * read twice: one says whether the stage happens, the other which pass it is.
   */
  readonly rvcEnabled = signal(this.openingPlan.convert);
  /**
   * WHICH PASS GOES FIRST when both run. Only read then — with one pass there is
   * no order — and it opens on the recommendation.
   */
  readonly enhancementOrder = signal<NarrationEnhancementOrder>('denoise-first');
  readonly applyDeRing = signal(false);

  /**
   * A video beside the M4B — seeded from Pipeline Defaults, as the wizard's
   * own check was (`generateVideo`).
   *
   * The RESOLUTION is per-run and starts where the wizard's did. Settings has
   * no field for it, and inventing one here would be this dialog answering a
   * question nobody has asked it yet.
   */
  readonly video = signal(this.defaults.generateVideo);
  readonly videoResolution = signal<VideoResolution>('720p');
  readonly videoResolutions = VIDEO_RESOLUTIONS;

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
    // Whether a Higgs run could start, asked once while the dialog is opening.
    // Cheap when the answer is "no Higgs on this build" and a single WSL round
    // trip otherwise, so it is not gated on the engine currently selected — the
    // user may switch to Higgs after it has already answered.
    void this.checkHiggsReady();

    /*
     * THE DOOR SETS THE PLAN.
     *
     * Re-run rather than read once, because this dialog outlives one press: the
     * host keeps it mounted while `target()` is non-null, so a Narrate pressed
     * in Foundry while a cache-only run is on screen would otherwise inherit
     * the previous door's locked Reading tab.
     */
    effect(() => {
      const plan = this.entryPlan(this.context());
      this.tab.set(plan.tab);
      this.narrate.set(plan.narrate);
      this.enhance.set(plan.enhance);
      this.finalDenoise.set(plan.denoise);
      this.rvcEnabled.set(plan.convert);
      this.assemble.set(plan.assemble);
    });

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

  // ── The Enhance stage and its two passes ──────────────────────────────────
  //
  // Three handlers rather than three `.set`s, because the stage check and the
  // pass checks say different things about each other and neither direction is
  // symmetrical. Written out here rather than as effects: an effect that moved a
  // check the user did not touch would be the bouncing control this dialog
  // refuses to have.

  /**
   * The TAB's own check — "at least one enhancement pass runs".
   *
   * Checking it with neither pass on turns the DENOISE on, because that is the
   * pass with nothing left to answer: the conversion needs a voice, and a check
   * that silently picked one would be this dialog choosing a tuning.
   *
   * Unchecking stops both and ERASES NEITHER. Checking is not selecting, so a
   * conversion tuned by ear survives being turned off and on again — the stage
   * flag is what the run reads, and the settings are still there under it.
   */
  onEnhanceToggled(on: boolean): void {
    this.enhance.set(on);
    if (on && !this.finalDenoise() && !this.rvcEnabled()) this.finalDenoise.set(true);
  }

  /**
   * A PASS's own check. Turning either on ticks the stage — asking for the pass
   * is asking for it to run, and leaving the tab unchecked afterwards would be a
   * setting that quietly does nothing.
   *
   * Turning the LAST one off unchecks the stage, for the same reason in reverse:
   * a checked tab with no pass behind it is a refusal waiting to happen, and the
   * user has just said which of the two things they meant.
   */
  onDenoiseToggled(on: boolean): void {
    this.finalDenoise.set(on);
    this.syncEnhanceStage(on);
  }

  onRvcToggled(on: boolean): void {
    this.rvcEnabled.set(on);
    this.syncEnhanceStage(on);
  }

  private syncEnhanceStage(turnedOn: boolean): void {
    if (turnedOn) { this.enhance.set(true); return; }
    if (!this.finalDenoise() && !this.rvcEnabled()) this.enhance.set(false);
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

  /**
   * A cache run cannot read the book, so its Reading tab is not a choice.
   *
   * Locked rather than merely unchecked: the cache door means "do something
   * with the sentences that are already there", and a check the user could turn
   * on would turn that press into a fresh read of a book they did not open this
   * from — which is an hour of GPU and a replaced audiobook.
   */
  readonly narrateLocked = computed(() => this.context() === 'cache');

  readonly narrateLockedNote =
    'Narration starts from the book — open this from the EPUB version to narrate a fresh '
    + 'session.';

  /** What the Reading check says about itself, locked or not. */
  readonly narrateCheckNote = computed(() =>
    this.narrateLocked() ? this.narrateLockedNote : 'Read the book aloud in this run');

  /** What each engine can do — worker ceiling, which sampling knobs are real. */
  private readonly caps = computed(() => engineCaps(this.engine()));

  readonly engineDisplayName = computed(() =>
    this.engines().find((e) => e.id === this.engine())?.displayName ?? this.engine());

  readonly maxWorkers = computed(() =>
    this.workerCfg.enabled() ? this.caps().maxWorkers : 1);

  /**
   * The voices this engine can be asked for.
   *
   * A voice carrying `unavailable` is rendered DISABLED with the reason as its
   * tooltip rather than dropped: a Higgs catalog entry whose artifact has not
   * landed is a voice everyone is waiting for, and silently omitting it leaves
   * nothing anywhere saying it exists. `stageRefusal` refuses it as well, for
   * the case where it arrives from a saved preset rather than a click.
   */
  readonly voiceOptions = computed<DesktopSelectItems>(() =>
    this.voices.voicesFor(this.engine()).map((v) => ({
      value: v.value,
      label: v.label,
      ...(v.unavailable ? { disabled: true, title: v.unavailable } : {}),
    })));

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
      && p.rvcEnhancementEnabled === this.rvcEnabled()
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
    // A preset states the CONVERSION, which is one of the two enhancement
    // passes, so it moves that pass's check and the stage follows the same rule
    // a click on the check follows. It says nothing about the denoise, so the
    // denoise is left exactly as the user set it.
    this.onRvcToggled(preset.rvcEnhancementEnabled);
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
      rvcEnhancementEnabled: this.rvcEnabled(),
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
   * Why the chosen stages cannot be run, or null.
   *
   * The two impossible shapes are refused HERE, on screen, rather than by
   * bouncing a toggle: a control that undoes itself when clicked tells the user
   * nothing about why.
   */
  readonly stageRefusal = computed<string | null>(() => {
    if (!this.narrate() && !this.enhance() && !this.assemble()) {
      return 'No tab is checked, so there is nothing to queue. Check at least one of the three '
        + 'above.';
    }
    if (this.enhance() && !this.assemble()) {
      return 'Enhancing the sentences without assembling them would spend the whole pass on the '
        + 'GPU and leave nothing to listen to. Check Assembly as well.';
    }
    if (this.enhance() && !this.finalDenoise() && !this.rvcEnabled()) {
      return 'Enhance is checked but neither pass is turned on, so it would do nothing. Turn on '
        + 'Denoise or Voice conversion on that tab, or uncheck it.';
    }
    if (this.video() && !this.assemble()) {
      // A video is rendered FROM the assembled audiobook and its subtitles, so
      // with no assembly there is no file to render one from. Said here rather
      // than by clearing the check, which would look like the click missed.
      return 'A video is made from the finished audiobook, and this run does not assemble one. '
        + 'Check Assembly, or turn the video off on that tab.';
    }
    if (!this.narrate() && this.cachedSentences() === null) {
      // WHICH INSTRUCTION IS USABLE depends on the door. From the cache row the
      // Reading tab is locked, so "check Reading" would name a control the user
      // cannot reach — the way out of this state is to open the dialog again
      // from the book.
      return this.narrateLocked()
        ? 'This book has no rendered sentences on disk, so there is nothing to enhance or '
          + 'assemble. ' + this.narrateLockedNote
        : 'This book has no rendered sentences on disk, so there is nothing to enhance or '
          + 'assemble. Check Reading to read it first.';
    }
    if (this.enhance() && this.rvcEnabled() && !this.rvcInstalled()) {
      return this.rvcUnavailableNote;
    }
    if (this.enhance() && this.rvcEnabled() && !this.rvcVoiceId()) {
      return 'No conversion voice is chosen, so there is nothing to re-render the sentences '
        + 'through. Pick one on the Enhance tab, or turn the conversion off there.';
    }
    if (this.narrate() && !this.voice()) {
      return 'No voice is selected, so this run would be rendered in whatever voice the queue '
        + 'happened to default to. Pick one on the Reading tab.';
    }
    // A retired engine reaching this far means the choice came from a saved
    // PRESET or from pipeline defaults written before the retirement — the
    // picker itself cannot offer one. Named here rather than left to the bridge
    // because a person with the dialog still open can just pick another engine.
    if (this.narrate() && !isRunnableTtsEngine(this.engine())) {
      const caps = TTS_ENGINES[this.engine()];
      return `${caps.displayName} was retired on ${caps.retired?.since} and cannot render this book. `
        + `${caps.retired?.reason ?? ''} Pick another engine on the Reading tab.`;
    }
    // The Higgs environment, asked BEFORE the job is queued rather than an hour
    // into it. `higgsReady` is a snapshot the dialog takes on open (see
    // checkHiggsReady) — a live probe cannot run inside a computed, and the
    // bridge re-checks at spawn time anyway, which is what catches an env that
    // broke between queueing and starting.
    if (this.narrate() && this.engine() === 'higgs') {
      const why = this.higgsBlocked();
      if (why) return why;
    }
    // A voice the catalog lists but cannot render — an artifact that has not
    // landed. The picker disables it, so reaching here means it arrived from a
    // saved preset or from pipeline defaults, which the picker never touched.
    if (this.narrate()) {
      const chosen = this.voices.voicesFor(this.engine()).find((v) => v.value === this.voice());
      if (chosen?.unavailable) {
        return `The voice "${chosen.label.replace(/ — not installed yet$/, '')}" cannot render yet: `
          + `${chosen.unavailable.split('.')[0]}. Pick another voice on the Reading tab.`;
      }
    }
    return null;
  });

  /**
   * Why a Higgs run cannot start, as of when this dialog opened. Null when it can,
   * or when the check has not answered yet — an unanswered probe is not evidence
   * of a broken environment, and blocking on it would make the button dead for as
   * long as WSL takes to wake up. The bridge's own preflight is the real gate.
   */
  readonly higgsBlocked = signal<string | null>(null);

  /**
   * Ask main whether the Higgs stack is usable. Fire-and-forget from ngOnInit.
   *
   * THE REMEDY COMES FROM THE DOCTOR, and this method must not invent one. Higgs
   * has two backends — the WSL vLLM-Omni server on Windows, the in-process MLX
   * one on macOS — and until 2026-09-05 this line ended "Set it up in Settings →
   * Higgs", which on a Mac points at a panel whose only button builds a WSL
   * environment. Main knows which arm it examined; this dialog does not, and the
   * moment it tried to it would be a second place to keep in step.
   */
  private async checkHiggsReady(): Promise<void> {
    const api = (window as any).electron?.higgsModels;
    if (!api?.doctor) return;
    const res = await api.doctor();
    if (!res?.success || !res.data) return;
    const failed = (res.data.checks ?? []).filter((c: { ok: boolean }) => !c.ok);
    this.higgsBlocked.set(
      failed.length === 0
        ? null
        : 'The Higgs environment is not ready, so this run would fail as soon as it started: '
          + failed.map((c: { label: string }) => c.label).join(', ')
          + `. ${res.data.remedy} Or pick Orpheus on the Reading tab.`,
    );
  }

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
    //
    // ONLY when the run could read it. A cache run never opens the document —
    // it converts and assembles sentences rendered weeks ago — and the file it
    // names is there to say WHICH VERSION the audiobook is filed against. So a
    // project whose sole version is not an EPUB can still be reassembled, and
    // refusing it here would have been a rule about a file nothing reads.
    if (!this.narrateLocked() && !/\.epub$/i.test(this.epubPath())) {
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
   * The video step, as this window's queue takes it.
   *
   * A MAPPING and nothing else — the composition is `narrationVideoStep`
   * (shared/queue/narration-video.ts), for the same reason the narration run's
   * lives in shared/: what a step consists of is not a fact about which window
   * asked for it, and a copy here would be a second answer to what a video job
   * carries. The `config` cast is the one `asJobRequest` makes over in
   * queue/jobs/narration-run.ts, checked on the other side by
   * `VideoAssemblyJobConfig` naming the same fields with the same types.
   */
  private videoRequest(book: NarrationRunBook): CreateJobRequest {
    const plan = narrationVideoStep(book, this.videoResolution(), RUN_LANGUAGE);
    return {
      type: plan.type,
      bfpPath: plan.bfpPath,
      metadata: { ...plan.metadata },
      config: plan.config as CreateJobRequest['config'],
    };
  }

  /**
   * Build the run and queue it — nothing runs here.
   *
   * Everything that can fail is in `buildNarrationJobs`, which throws with
   * nothing built rather than emitting a request with a hole in it: a workflow
   * half in the queue cannot be retried without double-queueing it.
   */
  /**
   * Say what is missing, and offer to fix it. True means go on and queue.
   *
   * Its own method because the sentence is the user's whole understanding of
   * why a button they pressed did not do what they expected — and because
   * "run it" and "run it again" are different instructions to somebody who
   * believes they already did.
   */
  private async offerCleanup(
    cleanup: { state: 'missing' | 'stale'; reason: string },
    book: NarrationRunBook,
  ): Promise<boolean> {
    // The row the user pressed, named in the dialog, because the file this run
    // ends up reading is NOT that row's file and saying so is the whole of the
    // honesty here (the second adversarial review's Finding 4, partial).
    const pressed = book.epubPath.split(/[\/]/).pop() ?? 'this version';
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Narration text cleanup',
      message: cleanup.reason,
      detail: `You pressed ${pressed}. The cleanup runs on this book's working copy and then `
        + 'cuts a fresh narration copy from it, and THAT is the file this run will read — not '
        + `the file on the row you pressed. It is minutes of model time over the blocks of `
        + `${book.title || 'the book'}, and it only has to happen once.`,
      confirmLabel: cleanup.state === 'stale'
        ? 'Run cleanup again, then narrate'
        : 'Run cleanup, then narrate',
      // INTERIM (Owen, 2026-09-05): the cleanup is optional. Declining means
      // "narrate as printed" and the run proceeds; the render door logs the
      // skip instead of refusing. The three-button yes/no/cancel form with a
      // project-level "cleanup done" flag is on fix/narration-cleanup-skip.
      cancelLabel: 'No, narrate as printed',
      type: 'question',
    });
    return confirmed;
  }

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
        language: RUN_LANGUAGE,
        ttsEngine: this.engine(),
        voice: this.voice(),
        device: this.device(),
        speed: this.speed(),
        workers: this.maxWorkers() > 1 ? this.workers() : 1,
        // Non-null by `refusal()`, which `submitDisabled` gates on: a run with
        // nowhere to file the audiobook is refused on screen rather than queued
        // with an empty output folder.
        outputDir: this.library.audiobooksPath()!,
        finalDenoise: this.finalDenoise(),
        // Only read when both passes run; stated always, because the run
        // description refuses a two-pass run that cannot say which order it is.
        enhancementOrder: this.enhancementOrder(),
        applyDeRing: this.applyDeRing(),
        /*
         * SENT ONLY WHEN THE USER MOVED IT. Absent means the session's own
         * provenance decides the gap — the voice's tuned value — and sending the
         * number the field was PRE-FILLED with would turn that living answer
         * into a frozen copy of what it happened to be when the dialog opened.
         */
        ...(this.showGap() && this.gapTouched() ? { sentenceGap: this.sentenceGap() } : {}),
        rvc: this.rvcEnabled()
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

      // The file this run actually reads. The pressed row by default; the
      // family book when the pressed export predates the cleanup and the user
      // said to narrate the current book instead.
      let narratedPath = book.epubPath;
      const jobs = buildNarrationJobs(book, settings, {
        narrate: this.narrate(),
        enhance: this.enhance(),
        assemble: this.assemble(),
      });

      /*
       * The video is appended AFTER the run, not built into it.
       *
       * `buildNarrationJobs` describes a narration run — the three steps main's
       * own door composes for Foundry's press too — and a video is not one of
       * them: it is a second rendering of the audiobook the run just made.
       * Adding it to the shared description would widen a contract two other
       * processes read, to carry a field only this dialog can ask about.
       *
       * Order is the lineage. The steps execute in the order they are queued
       * under the master row, so appending it last is what puts it after the
       * assembly that writes the files it reads — which is how the wizard
       * composed it, and it reads them from <projectDir>/output at RUN time,
       * when they exist.
       */
      if (this.video() && this.assemble()) jobs.push(this.videoRequest(book));

      /*
       * ── THE NARRATION TEXT CLEANUP HAS TO HAVE RUN ────────────────────────
       *
       * Owen, 2026-09-04: *"a step that can be performed at any point, including
       * on an epub, but it's a computationally expensive step that needs to take
       * place somewhere along the line, and everything after it is
       * finalized/fixed… If the user hits narrate before it does cleanup, it
       * tells the user it still needs to do the cleanup step; then it does the
       * cleanup step on whatever the last step they did before exporting the
       * epub they were trying to narrate, and then they export the epub and
       * queue narration."*
       *
       * NOT a lock. The gate says what is missing, by name, offers to fix it,
       * and on yes queues ONE run: the cleanup first, then this narration
       * chained behind it — which is what \`submitProcessingRun\`'s \`followOn\`
       * is for. The render door checks the same thing again on the FILE it is
       * handed, and that backstop is why this can afford to be a question.
       *
       * ONLY WHEN SOMETHING WILL BE READ. A cache-context run — "assemble the
       * clips I already rendered" — reads no book text at all, and demanding
       * minutes of model time over a book nobody is reading was the adversarial
       * review's Finding 15.
       */
      if (this.narrate()) {
        const readiness = await this.electron.narrationTextReadiness(
          book.projectDir, book.epubPath, undefined);
        if (!readiness.success) {
          throw new Error(
            `This book's history could not be read, so there is no way to tell whether the `
            + `narration text cleanup has run: ${readiness.error}`);
        }

        const chain = readiness.readiness ?? null;
        const file = readiness.fileState ?? null;

        /*
         * The CHAIN could not be named — a project with two book chains, and a
         * version row belonging to neither by name. The file's own stamp is
         * still authoritative (it is what the render door reads), so that is
         * what decides; what is lost is only the ability to offer a fix,
         * because nothing can say which chain to clean.
         */
        if (chain === null) {
          if (file !== null && !file.ok) {
            this.error.set(
              `${file.reason} ${readiness.familyNote ?? ''} Open the version this one came from `
              + 'and run the cleanup there.');
            return;
          }
        } else if (!chain.ok) {
          const proceed = await this.offerCleanup(chain, book);
          // "No, narrate as printed": fall through and queue the jobs as pressed.
          // The recorded-book check that used to sit here was dead — the pass runs
          // on the FILE the user pressed (`sourcePath` below), never on that value.
          if (proceed) {
          const run = await this.queue.submitProcessingRun({
            projectDir: book.projectDir,
            /*
             * The FILE the user pressed, so the planner resolves the chain it
             * belongs to and the pass cleans that book rather than the default
             * family's. The follow-on's own \`epubPath\` is NOT patched here: the
             * queue gives a chained step its parent's artifact and nothing else,
             * so what a narration step reads is what the pass NAMES — the
             * narration copy it re-cuts from the book it just wrote
             * (electron/processing-passes.ts, \`narrationInputPath\`). Patching
             * the request was inert, and the adversarial review measured it so.
             */
            sourcePath: book.epubPath,
            passes: [{ kind: 'narration-text' }],
          }, jobs);
          if (!run.success) throw new Error(run.error ?? 'The cleanup run could not be queued.');
          this.queued.emit({ jobs: jobs.length + 1 });
          return;
          }
        } else if (file !== null && !file.ok) {
          /*
           * The BOOK has been cleaned and this VERSION has not — an export made
           * before the cleanup ran. Queueing it would die in the render door
           * with the file's own sentence and nothing would offer a way out (the
           * adversarial review's Finding 8). So the way out is offered here.
           */
          const useBook = await this.electron.showConfirmDialog({
            title: 'This version was exported before the cleanup',
            message: file.reason,
            detail: 'The book itself has been cleaned. Narrate the current book instead? '
              + 'It is the same text, with the passages you struck out removed as usual.',
            confirmLabel: 'Narrate the current book',
            cancelLabel: 'Cancel',
            type: 'question',
          });
          if (!useBook.confirmed) { this.error.set(file.reason); return; }
          const current = readiness.bookPath;
          if (current === null || current === undefined) {
            throw new Error(
              'This project could not name its current book, so there is nothing to narrate in '
              + 'place of the export. Nothing was queued.');
          }
          /*
           * EVERY COPY OF THE PATH, not just `epubPath`. `buildNarrationSteps`
           * also sets `sourceRef: {kind:'epub', path}` on the tts step, and the
           * queue PREFERS `sourceRef` when it resolves a parentless step's
           * input — so patching `epubPath` alone left the run reading the stale
           * export while the card claimed the current book (the second
           * adversarial review, 2026-09-04).
           */
          const wasPressed = book.epubPath;
          for (const job of jobs) {
            if (job.epubPath === wasPressed) job.epubPath = current;
            if (job.sourceRef?.kind === 'epub' && job.sourceRef.path === wasPressed) {
              job.sourceRef = { ...job.sourceRef, path: current };
            }
          }
          narratedPath = current;
        }
      }


      const workflowId = `tts-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const master = await this.queue.addJob({
        type: 'audiobook',
        epubPath: narratedPath,
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
