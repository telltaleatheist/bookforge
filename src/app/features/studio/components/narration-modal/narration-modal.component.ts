/**
 * The narration modal: press Process on the TTS copy, say how it should be read,
 * and it goes to the queue.
 *
 * ── Owen's two rules, both structural ───────────────────────────────────────
 *
 * "maybe we turn the tts/assembly page into a modal that appears when the user
 * hits process on the tts file" — and — "whatever the user chooses to do
 * (particularly translate/simplify/tts/assemble) will be added to the queue
 * instead of done right there on the spot. i guess we could follow the vlm epub
 * generation pattern."
 *
 * So this dialog decides nothing and runs nothing. It collects choices and
 * enqueues rows the user can watch and cancel on the Queue tab, exactly as
 * "Convert to EPUB" does and exactly as the book passes on this page do.
 *
 * ── The identity law ────────────────────────────────────────────────────────
 *
 * "the tts pipeline knows exactly which file its working with because the user
 * came to the tts page FROM the button on that document. no ambiguity, no
 * confusion."
 *
 * The file is an INPUT. It is not looked up, not resolved, and not defaulted:
 * the row that carried the Process button named it, the versions page passed it
 * here, and the dialog SHOWS it — because a run that narrates the wrong file
 * looks completely ordinary until somebody listens to the result. The same path
 * goes into the queued job.
 *
 * ── Why the jobs are not built here ─────────────────────────────────────────
 *
 * They are built by `queue/jobs/narration-run.ts`, which the Process page asks
 * for the same three requests. Two doors composing their own runs is how one of
 * them ends up a field behind the other, and the field that goes missing is
 * always the one nobody notices until an hour of GPU has been spent.
 */
import { Component, ChangeDetectionStrategy, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DesktopSelectComponent, type DesktopSelectItems } from '../../../../creamsicle-desktop';
import { SettingsService } from '../../../../core/services/settings.service';
import { LibraryService } from '../../../../core/services/library.service';
import { ComponentService } from '../../../../core/services/component.service';
import { WorkerConfigService } from '../../../../core/services/worker-config.service';
import { QueueService } from '../../../queue/services/queue.service';
import { NarrationVoicesService } from '../../../queue/jobs/narration-voices.service';
import {
  buildNarrationJobs,
  type NarrationRunBook,
  type NarrationRunSettings,
} from '../../../queue/jobs/narration-run';
import { engineCaps, selectableEngines } from '../../../language-learning/models/tts-engine-registry';
import type { TTSEngine } from '../../../language-learning/models/language-learning.types';

/** The basename of a path, for showing WHICH file without the whole path. */
function fileName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fullPath;
}

@Component({
  selector: 'app-narration-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DesktopSelectComponent],
  template: `
    <div class="nm-backdrop" (click)="onCancel()">
      <div class="nm-modal" (click)="$event.stopPropagation()">
        <h3 class="nm-title">Narrate this file</h3>

        <!-- WHICH file. Shown, not implied: the run is about one document and the
             user is owed the chance to notice it is the wrong one. -->
        <div class="nm-file" [title]="epubPath()">
          <span class="nm-file-icon">📖</span>
          <span class="nm-file-name">{{ fileLabel() }}</span>
        </div>

        @if (refusal(); as why) {
          <div class="nm-err">{{ why }}</div>
        } @else {
          <p class="nm-sub">
            This is added to the queue, where it can be watched and cancelled. It runs when the
            queue reaches it.
          </p>

          <!-- What the run does. Both on by default: a narration nobody assembles
               leaves rendered sentences and no audiobook. -->
          <div class="nm-row nm-checks">
            <label class="nm-check">
              <input type="checkbox" [checked]="narrate()"
                     (change)="narrate.set($any($event.target).checked)" />
              <span>Read the book aloud</span>
            </label>
            <label class="nm-check">
              <input type="checkbox" [checked]="assemble()"
                     (change)="assemble.set($any($event.target).checked)" />
              <span>Assemble the audiobook</span>
            </label>
          </div>

          @if (narrate()) {
            <div class="nm-field">
              <label class="nm-label">Engine</label>
              <div class="nm-choices">
                @for (eng of engines(); track eng.id) {
                  <button type="button" class="nm-choice"
                          [class.on]="engine() === eng.id"
                          [title]="eng.statusText"
                          (click)="selectEngine(eng.id)">{{ eng.displayName }}</button>
                }
              </div>
            </div>

            <div class="nm-field">
              <label class="nm-label">Voice</label>
              <desktop-select
                [options]="voiceOptions()"
                [ngModel]="voice()"
                (ngModelChange)="voice.set($event)"
              />
            </div>

            <div class="nm-field">
              <label class="nm-label">Device</label>
              <div class="nm-choices">
                @for (d of devices; track d.id) {
                  <button type="button" class="nm-choice" [class.on]="device() === d.id"
                          (click)="device.set(d.id)">{{ d.label }}</button>
                }
              </div>
            </div>

            <div class="nm-field">
              <label class="nm-label">Speed: {{ speed() }}x</label>
              <input type="range" class="nm-slider" min="0.5" max="2" step="0.05"
                     [value]="speed()" (input)="speed.set(+$any($event.target).value)" />
            </div>

            @if (maxWorkers() > 1) {
              <div class="nm-field">
                <label class="nm-label">Workers: {{ workers() }}</label>
                <input type="range" class="nm-slider" min="1" [max]="maxWorkers()" step="1"
                       [value]="workers()" (input)="workers.set(+$any($event.target).value)" />
                <span class="nm-hint">More workers render faster on CPU. A GPU run uses one.</span>
              </div>
            }

            @if (showsSampling()) {
              <button type="button" class="nm-accordion" (click)="advancedOpen.set(!advancedOpen())">
                {{ advancedOpen() ? '▼' : '▶' }} Advanced
              </button>
              @if (advancedOpen()) {
                <div class="nm-field">
                  <label class="nm-label">Temperature: {{ temperature() }}</label>
                  <input type="range" class="nm-slider" min="0.1" max="1.0" step="0.05"
                         [value]="temperature()" (input)="temperature.set(+$any($event.target).value)" />
                </div>
                <div class="nm-field">
                  <label class="nm-label">Top P: {{ topP() }}</label>
                  <input type="range" class="nm-slider" min="0.1" max="1.0" step="0.05"
                         [value]="topP()" (input)="topP.set(+$any($event.target).value)" />
                </div>
                <div class="nm-field">
                  <label class="nm-label">Repetition penalty: {{ repetitionPenalty() }}</label>
                  <input type="range" class="nm-slider" min="1" max="10" step="0.5"
                         [value]="repetitionPenalty()"
                         (input)="repetitionPenalty.set(+$any($event.target).value)" />
                </div>
              }
            }
          }

          @if (assemble()) {
            <div class="nm-field">
              <label class="nm-label">Assembly</label>
              <label class="nm-check">
                <input type="checkbox" [checked]="finalDenoise()"
                       (change)="finalDenoise.set($any($event.target).checked)" />
                <span>Denoise the finished audio</span>
              </label>
              <label class="nm-check">
                <input type="checkbox" [checked]="applyDeRing()"
                       (change)="applyDeRing.set($any($event.target).checked)" />
                <span>Remove ringing</span>
              </label>
            </div>

            @if (rvcInstalled()) {
              <div class="nm-field">
                <label class="nm-check">
                  <input type="checkbox" [checked]="rvcEnabled()"
                         (change)="rvcEnabled.set($any($event.target).checked)" />
                  <span>Re-render through an RVC voice</span>
                </label>
                @if (rvcEnabled()) {
                  <desktop-select
                    [options]="rvcVoiceOptions()"
                    [ngModel]="rvcVoiceId()"
                    (ngModelChange)="rvcVoiceId.set($event)"
                  />
                  <span class="nm-hint">Index {{ rvcIndexRate() }} · protect {{ rvcProtectRate() }}
                    · {{ rvcNSemitones() }} semitones. Change these in Settings.</span>
                }
              </div>
            }
          }

          @if (error(); as e) { <div class="nm-err">{{ e }}</div> }
        }

        <!-- The runs this dialog does not describe: resuming a half-rendered
             session, reassembling a cached one. Those are about something
             already on disk rather than about a book, and the Process page
             still finds them. The same file goes with the press. -->
        <button type="button" class="nm-more" (click)="onMoreOptions()">
          More options — resume or reassemble on the Process page →
        </button>

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
      width: min(560px, 100%); max-height: 85vh; overflow: auto;
      background: var(--bg-surface, var(--bg-elevated)); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 12px; padding: 20px 22px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    }
    .nm-title { margin: 0 0 10px 0; font-size: 1.05rem; font-weight: 700; }
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
    .nm-sub { margin: 12px 0 4px 0; font-size: 0.78rem; color: var(--text-secondary); line-height: 1.45; }
    .nm-row { display: flex; flex-wrap: wrap; gap: 14px; }
    .nm-checks { margin-top: 12px; }
    .nm-field { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
    .nm-label { font-size: 0.78rem; font-weight: 600; }
    .nm-hint { font-size: 0.72rem; color: var(--text-secondary); line-height: 1.4; }
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
    .nm-slider { width: 100%; }
    .nm-accordion {
      margin-top: 14px; padding: 0; background: none; border: none; cursor: pointer;
      font-family: inherit; font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);
      text-align: left;
    }
    .nm-err { margin-top: 12px; font-size: 0.78rem; color: #ef4444; line-height: 1.45; }
    .nm-more {
      display: block; margin-top: 18px; padding: 0;
      background: none; border: none; cursor: pointer; font-family: inherit;
      font-size: 0.74rem; color: var(--text-secondary); text-align: left;
    }
    .nm-more:hover { color: var(--accent-primary, #06b6d4); }
    .nm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
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
  private readonly queue = inject(QueueService);
  private readonly voices = inject(NarrationVoicesService);

  /**
   * THE file this run narrates — the path the Process button carried.
   *
   * `required` because a modal with nothing to narrate is not a state this
   * dialog has: the button that opens it is on a line that names a document.
   */
  readonly epubPath = input.required<string>();
  /**
   * WHICH VERSION of the book that file is — the other half of its identity.
   *
   * `required` for the same reason the path is. Owen, 2026-08-10: "if the user
   * wants to process a specific TTS document then they click the process button
   * next to it. no ambiguity, no confusion." The row the button is on IS a
   * version of this book and carries its id; nothing on this side could work it
   * out, and a run that guessed would be filed against the wrong edition.
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
  /**
   * Take this file to the full Process page instead.
   *
   * The one door out that is not a cancel. It carries nothing because the host
   * already holds the path it opened this dialog with — the file cannot change
   * on the way across, which is the point.
   */
  readonly moreOptions = output<void>();

  /**
   * The engines that can be chosen right now — the registry's own gate, so an
   * engine whose environment is not installed is not offered here and offered
   * on the Process page (or the reverse).
   */
  readonly engines = computed(() =>
    selectableEngines((id) => this.components.isInstalled(id)));

  readonly devices: ReadonlyArray<{ id: 'auto' | 'gpu' | 'mps' | 'cpu'; label: string }> = [
    { id: 'auto', label: 'Auto' },
    { id: 'gpu', label: 'GPU' },
    { id: 'mps', label: 'Metal' },
    { id: 'cpu', label: 'CPU' },
  ];

  // ── Seeded from Pipeline Defaults, exactly as the Process page seeds ───────
  //
  // Read ONCE, at construction, rather than through a computed: these are the
  // run's settings from here on, and a defaults change while the dialog is open
  // must not silently move a control the user has already set.
  private readonly defaults = this.settings.getPipelineDefaults();

  readonly narrate = signal(true);
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
  readonly rvcEnabled = signal(this.defaults.rvcEnhancementEnabled);
  readonly rvcVoiceId = signal(this.defaults.rvcEnhancementVoiceId);
  readonly rvcIndexRate = signal(this.defaults.rvcEnhancementIndexRate);
  readonly rvcProtectRate = signal(this.defaults.rvcEnhancementProtectRate);
  readonly rvcNSemitones = signal(this.defaults.rvcEnhancementNSemitones);

  readonly advancedOpen = signal(false);
  readonly submitting = signal(false);
  /** The refusal from the last submission, main's or the builder's, verbatim. */
  readonly error = signal<string | null>(null);

  constructor() {
    // The catalog is the machine's, loaded once per app; asking again is free.
    void this.voices.load();
  }

  readonly fileLabel = computed(() => fileName(this.epubPath()));

  /** What each engine can do — worker ceiling, which sampling knobs are real. */
  private readonly caps = computed(() => engineCaps(this.engine()));

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

  /**
   * Why this dialog cannot queue anything, or null.
   *
   * The two facts a run cannot be described without, checked here so the reason
   * is on screen rather than thrown at the moment of submission.
   */
  readonly refusal = computed<string | null>(() => {
    if (!this.epubPath()) {
      return 'The Process button did not name a file, so there is nothing to narrate. This is a '
        + 'bug in the page that opened this dialog.';
    }
    // The file is handed over already proved to be on disk (the row's own
    // `variantFile` check); what this side can still say is whether it is a
    // BOOK. An M4B or a PDF reaching here would be queued and would fail an
    // hour later inside the TTS job, naming a path the user cannot place.
    if (!/\.epub$/i.test(this.epubPath())) {
      return `${this.fileLabel()} is not an EPUB, so it cannot be narrated. Narration reads a `
        + 'book; press Process on an EPUB version of this book.';
    }
    if (!this.variantId()) {
      return 'The Process button did not say which version of the book this file is, so the run '
        + 'could not be filed against one. This is a bug in the page that opened this dialog.';
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
    this.submitting()
    || this.refusal() !== null
    || (!this.narrate() && !this.assemble()));

  onCancel(): void {
    if (this.submitting()) return;
    this.cancelled.emit();
  }

  onMoreOptions(): void {
    if (this.submitting()) return;
    this.moreOptions.emit();
  }

  /**
   * Build the run and queue it — nothing runs here.
   *
   * Everything that can fail is in `buildNarrationJobs`, which throws with
   * nothing built rather than emitting a request with a hole in it: a workflow
   * half in the queue cannot be retried without double-queueing it. The rows go
   * in under one workflow with a master row of their own, exactly as the Process
   * page queues a run with no passes ahead of it.
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
        // Non-null by `refusal()`, which is what `submitDisabled` gates on: a
        // run with nowhere to file the audiobook is refused on screen rather
        // than queued with an empty output folder.
        outputDir: this.library.audiobooksPath()!,
        finalDenoise: this.finalDenoise(),
        applyDeRing: this.applyDeRing(),
        rvc: this.rvcEnabled() && this.rvcInstalled()
          ? {
              voiceId: this.rvcVoiceId(),
              indexRate: this.rvcIndexRate(),
              protectRate: this.rvcProtectRate(),
              nSemitones: this.rvcNSemitones(),
            }
          : null,
        // This dialog never offers Continue, so it never asks the queue to clear
        // a cached session. Resuming a partial render is the Process page's, and
        // sending `true` from here would throw away an hour of GPU nobody
        // mentioned.
        startFresh: false,
      };

      const jobs = buildNarrationJobs(book, settings, {
        narrate: this.narrate(),
        assemble: this.assemble(),
      });

      const workflowId = `tts-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const master = await this.queue.addJob({
        type: 'audiobook',
        epubPath: book.epubPath,
        variantId: book.variantId,
        ...(book.isArticle ? { projectDir: book.projectDir } : {}),
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
