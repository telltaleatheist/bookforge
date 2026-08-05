/**
 * The unified processing pipeline wizard (formerly LLWizard).
 *
 * Four steps for ALL audiobook production:
 * 1. Passes    - pick the book, then compose the run (skippable)
 * 2. TTS       - single voice (standard) or per-language rows (sentence-aligned)
 * 3. Assembly  - M4B+VTT reassembly (standard) or bilingual interleave
 * 4. Review    - summary before submission
 *
 * Page 1 carries the RUN TYPE, and that is what decides the shape of everything
 * behind it:
 *
 * - **Standard** composes a list of PASSES over one of the project's files —
 *   Tesseract, OCR correction, footnote removal, simplify, translate — validated
 *   and queued through `processing:submit-chain` (see docs/PROCESSING_PIPELINE_V2.md).
 *   Narration and assembly are queued behind the passes in the same workflow.
 * - **Language learning** is a different product: sentence-aligned translation
 *   into one or more languages, per-language narration, interleaved assembly. It
 *   is not expressible as passes over one book, so it keeps the cleanup +
 *   translation configuration it always had — on page 1, under the switch.
 */

import { Component, input, output, signal, computed, inject, OnInit, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  SettingsService,
  STOCK_TTS_SAMPLING,
  PipelinePreset,
  PipelinePresetConfig,
} from '../../../../core/services/settings.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { LibraryService } from '../../../../core/services/library.service';
import { collapseFilenameDots } from '../../../../core/utils/filename-utils';
import { QueueService } from '../../../queue/services/queue.service';
import { ComponentService } from '../../../../core/services/component.service';
import { TtsConversionConfig, ReassemblyJobConfig, CleanupStages } from '../../../queue/models/queue.types';
import { AssembleAuditionPlayerComponent } from './assemble-audition-player.component';
import type { CorrectSentencesSession } from '../../../correct-sentences/models/correct-sentences.types';
import { EpubResolverService } from '../../services/epub-resolver.service';
import { AiService } from '../../../../core/services/ai.service';
import { LanguagePackService } from '../../../../core/services/language-pack.service';
import { WorkerConfigService } from '../../../../core/services/worker-config.service';
import {
  SUPPORTED_LANGUAGES,
  TtsLanguageRow,
  SessionCache,
  LLWizardStep,
  SourceDropdownOption,
  AvailableEpub,
  TTSEngine
} from '../../models/language-learning.types';
import { TTS_ENGINES, engineCaps, type TtsEngineCaps } from '../../models/tts-engine-registry';
import { AIProvider } from '../../../../core/models/ai-config.types';
import type {
  ChainPassRequest,
  FootnotesPassParams,
  ProcessingChainPlan,
  ProcessingChainRequest,
  ProcessingPassKind,
  SimplifyPassParams,
  TranslatePassParams,
} from '@shared/processing/pass-types';
import type { TextLayerReport } from '@shared/pdf/text-layer';
import type { SourceType } from '../../../../core/models/manifest.types';
import {
  DesktopSelectComponent,
  DesktopSelectItems,
  DesktopSelectOptionGroup,
  DialogService,
} from '../../../../creamsicle-desktop';

// ─────────────────────────────────────────────────────────────────────────────
// Source Stage Types
// ─────────────────────────────────────────────────────────────────────────────

interface SourceStage {
  id: 'original' | 'exported' | 'repaired' | 'cleaned' | 'simplified' | 'translated';
  label: string;
  completed: boolean;
  path: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass builder types
// ─────────────────────────────────────────────────────────────────────────────

/** A file the passes can be pointed at: a project version, or the book EPUB. */
interface PassVariantCard {
  /** The variant id sent to the planner. '' means "the project's book EPUB". */
  id: string;
  label: string;
  format: string;
  filename: string;
  /** The file itself. Read to measure a PDF's text layer, never to build a path. */
  absPath: string;
  /** Non-empty when this file cannot be processed — and says why, on the card. */
  disabledReason: string;
}

/**
 * One pass in the sidebar. `uid` exists only so @for can track a row across
 * reorders and duplicates; nothing downstream ever sees it.
 */
interface BuilderPass {
  uid: string;
  kind: ProcessingPassKind;
  /** Footnote removal over an EPUB. Meaningless on a PDF run — see selectVariant. */
  footnotes?: FootnotesPassParams;
  simplify?: SimplifyPassParams;
  translate?: TranslatePassParams;
}

/** What the palette offers for the chosen book, and why an entry is closed. */
interface PalettteEntry {
  kind: ProcessingPassKind;
  label: string;
  desc: string;
  enabled: boolean;
  why: string;
}

/**
 * The pass names the user sees. MIRRORS `LABEL_OF` in electron/processing-chain.ts:
 * the planner's refusals are sentences that open with the label of the pass they
 * are about, and `chainErrorAt` matches on that to put the message on the right
 * row. Change one, change both.
 *
 * The three document passes are named for the document each produces rather than
 * for the machinery inside it — the user is composing transformations of their
 * book, not scheduling stages of a scanner.
 */
const PASS_LABELS: Record<ProcessingPassKind, string> = {
  'get-text': 'Get Text',
  blocks: 'Detect blocks',
  reflow: 'Build the book',
  footnotes: 'Footnote removal',
  simplify: 'Simplify',
  translate: 'Translate',
};

/**
 * The passes that read the working PDF and nothing else.
 *
 * Footnote removal is deliberately NOT one of them: it rewrites the working
 * PDF's text layer on a PDF run and the book EPUB otherwise, so switching the
 * run to an EPUB keeps it (mirroring `DOCUMENT_ONLY_KINDS` in
 * electron/processing-chain.ts).
 */
const SCAN_ONLY_PASS_KINDS: ReadonlySet<ProcessingPassKind> = new Set<ProcessingPassKind>([
  'get-text',
  'blocks',
  'reflow',
]);

/** A queue submission as the wizard builds it, before the queue stamps its ids. */
type QueueJobRequest = Parameters<QueueService['addJob']>[0];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-ll-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopSelectComponent, AssembleAuditionPlayerComponent],
  template: `
    <div class="wizard">
      <!-- Step Indicator -->
      <div class="step-indicator">
        <div class="step" [class.active]="currentStep() === 'passes'" [class.completed]="isStepCompleted('passes')" [class.skipped]="isStepSkipped('passes')" [class.has-data]="hasStageData('cleanup')">
          <span class="step-num">1</span>
          <span class="step-label">{{ pipelineMode() === 'mono' ? 'Passes' : 'Text' }}</span>
          @if (hasStageData('cleanup')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'tts'" [class.completed]="isStepCompleted('tts')" [class.skipped]="isStepSkipped('tts')" [class.has-data]="hasStageData('tts')">
          <span class="step-num">2</span>
          <span class="step-label">TTS</span>
          @if (hasStageData('tts')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'assembly'" [class.completed]="isStepCompleted('assembly')" [class.skipped]="isStepSkipped('assembly')" [class.has-data]="hasStageData('assembly')">
          <span class="step-num">3</span>
          <span class="step-label">Enhance &amp; Assemble</span>
          @if (hasStageData('assembly')) { <span class="data-dot" title="Data exists"></span> }
        </div>
        <div class="step-connector"></div>
        <div class="step" [class.active]="currentStep() === 'review'" [class.completed]="isStepCompleted('review')">
          <span class="step-num">4</span>
          <span class="step-label">Review</span>
        </div>
      </div>

      <!-- Step Content -->
      <div class="step-content">
        @switch (currentStep()) {
          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 1: the pass builder (standard) / text prep (sentence-aligned) -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('passes') {
            <div class="step-panel scrollable">
              <!-- Run type. Standard composes a list of passes over ONE book.
                   Language learning is a different product — two books read in
                   sentence-aligned pairs — and is not expressible as passes over
                   one, so it keeps its own configuration below. -->
              <div class="config-section">
                <label class="field-label">Run type</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="pipelineMode() === 'mono'"
                    (click)="selectRunType('standard')"
                  >
                    <span class="provider-name">Standard</span>
                    <span class="provider-status">One book, one narration</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="pipelineMode() === 'bilingual'"
                    (click)="selectRunType('language-learning')"
                  >
                    <span class="provider-name">Language learning</span>
                    <span class="provider-status">Sentence-aligned pair</span>
                  </button>
                </div>
              </div>

              @if (pipelineMode() === 'mono') {
                <h3>Processing passes</h3>
                <p class="step-desc">Pick the book, then stack the passes to run over it. They run top to bottom.</p>

                <!-- Simplify and Translate need a model → same layover the cleanup step used -->
                @if (ai.checkedOnce() && !ai.available()) {
                  <div class="ai-layover">
                    <div class="ai-layover-card">
                      <div class="ai-layover-icon">&#129302;</div>
                      <h4>AI isn't set up yet</h4>
                      <p>Use the AI Setup wizard to enable the simplify &amp; translate passes — add a bundled local model, connect Ollama, or save a Claude/OpenAI key.</p>
                      <button class="ai-layover-btn" (click)="openAiSetup()">Open AI Setup wizard</button>
                    </div>
                  </div>
                }

                <!-- The book the passes apply to: this project's versions, as the
                     metadata page lists them, plus its own book EPUB. -->
                <div class="config-section">
                  <label class="field-label">Which book</label>
                  @if (variantCards().length === 0) {
                    <div class="no-models">
                      @if (loadingVariants()) {
                        Looking for this project's files…
                      } @else {
                        <span class="error-text">This project has no PDF or EPUB to process.</span> Add one on the Versions tab.
                      }
                    </div>
                  } @else {
                    <div class="variant-cards">
                      @for (card of variantCards(); track card.id) {
                        <button
                          type="button"
                          class="variant-card"
                          [class.selected]="selectedVariantId() === card.id"
                          [disabled]="!!card.disabledReason"
                          (click)="selectVariant(card)"
                        >
                          <span class="variant-format">{{ card.format.toUpperCase() }}</span>
                          <span class="variant-title">{{ card.label }}</span>
                          <span class="variant-file">{{ card.filename }}</span>
                          @if (card.disabledReason) {
                            <span class="variant-note">{{ card.disabledReason }}</span>
                          }
                        </button>
                      }
                    </div>
                  }
                </div>

                <!-- What the chosen PDF is: a book with text in it, or pictures of
                     pages. It decides whether the OCR unit is a choice. A check
                     that failed says so — it never reads as "optional". -->
                @if (selectedIsPdf()) {
                  @if (measuringTextLayer()) {
                    <span class="hint">Checking whether this PDF has any text of its own…</span>
                  } @else if (textLayerError()) {
                    <div class="pass-error">{{ textLayerError() }}</div>
                  } @else if (ocrRequiredReason()) {
                    <span class="hint">{{ ocrRequiredReason() }}</span>
                  } @else if (textLayer()) {
                    <span class="hint">This PDF already has text of its own, so the OCR pass is optional.</span>
                  }
                }

                <div class="pass-builder">
                  <!-- Palette, filtered by what the chosen book can be read as -->
                  <div class="pass-palette">
                    <label class="field-label">Add a pass</label>
                    @for (opt of passPalette(); track opt.kind) {
                      <button
                        type="button"
                        class="palette-btn"
                        [class.open]="palettePanel() === opt.kind"
                        [disabled]="!opt.enabled"
                        [title]="opt.enabled ? '' : opt.why"
                        (click)="onPaletteClick(opt.kind)"
                      >
                        <span class="palette-name">{{ opt.label }}</span>
                        <span class="palette-desc">{{ opt.enabled ? opt.desc : opt.why }}</span>
                      </button>

                      @if (palettePanel() === opt.kind && opt.kind === 'footnotes') {
                        <div class="palette-panel">
                          <label class="field-label">
                            <input type="checkbox" [checked]="passFootnotesAskEverything()"
                                   (change)="passFootnotesAskEverything.set($any($event.target).checked)" />
                            Also check note bodies and index entries
                          </label>
                          <span class="hint">
                            Normally skipped to protect them: a note's own number and an index entry's
                            page numbers look exactly like reference markers, and removing them
                            destroys the numbering. Turn this on only for a book whose markers are
                            being missed.
                          </span>
                          <button
                            type="button"
                            class="palette-add-btn"
                            (click)="addFootnotesPass()"
                          >
                            Add footnote-removal pass
                          </button>
                        </div>
                      }

                      @if (palettePanel() === opt.kind && opt.kind === 'simplify') {
                        <div class="palette-panel">
                          <label class="field-label">AI model</label>
                          @if (aiSourceGroups().length > 0) {
                            <desktop-select
                              class="select-input"
                              [options]="aiModelGroups()"
                              [ngModel]="cleanupSelection()"
                              (ngModelChange)="onCleanupModelChange($event)"
                            />
                          } @else {
                            <div class="no-models"><span class="error-text">No AI configured.</span></div>
                          }
                          <div class="mode-options">
                            @for (m of simplifyModeOptions; track m.value) {
                              <button
                                type="button"
                                class="mode-option"
                                [disabled]="!cleanupModel()"
                                (click)="addSimplifyPass(m.value)"
                              >
                                <span class="mode-label">{{ m.label }}</span>
                                <span class="mode-desc">{{ m.desc }}</span>
                              </button>
                            }
                          </div>
                          <span class="hint">Pick a mode to add the pass. Add it twice for two modes.</span>
                        </div>
                      }

                      @if (palettePanel() === opt.kind && opt.kind === 'translate') {
                        <div class="palette-panel">
                          <label class="field-label">AI model</label>
                          @if (aiSourceGroups().length > 0) {
                            <desktop-select
                              class="select-input"
                              [options]="aiModelGroups()"
                              [ngModel]="translateSelection()"
                              (ngModelChange)="onTranslateModelChange($event)"
                            />
                          } @else {
                            <div class="no-models"><span class="error-text">No AI configured.</span></div>
                          }
                          <div class="lang-pair">
                            <div class="lang-pair-field">
                              <label class="field-label">From</label>
                              <desktop-select
                                class="select-input"
                                [options]="languageOptions()"
                                [ngModel]="passTranslateSource()"
                                (ngModelChange)="passTranslateSource.set($event)"
                              />
                            </div>
                            <div class="lang-pair-field">
                              <label class="field-label">Into</label>
                              <desktop-select
                                class="select-input"
                                [options]="languageOptions()"
                                [ngModel]="passTranslateTarget()"
                                (ngModelChange)="passTranslateTarget.set($event)"
                              />
                            </div>
                          </div>
                          <button
                            type="button"
                            class="palette-add-btn"
                            [disabled]="passTranslateSource() === passTranslateTarget() || !translateModel()"
                            (click)="addTranslatePass()"
                          >
                            Add translate pass
                          </button>
                          <span class="hint">Translation leaves no diff — the whole text changes.</span>
                        </div>
                      }
                    }

                    <div class="config-section">
                      <label class="field-label">Custom Instructions</label>
                      <textarea
                        class="custom-instructions"
                        [value]="customInstructions()"
                        (input)="customInstructions.set($any($event.target).value)"
                        placeholder="Optional: Add specific instructions for the AI (e.g., 'Keep chapter epigraphs as they are')"
                        rows="3"
                      ></textarea>
                      <span class="hint">Carried by every simplify/translate pass added after you type it.</span>
                    </div>
                  </div>

                  <!-- The run itself, in execution order -->
                  <div class="pass-sidebar">
                    <label class="field-label">This run</label>

                    @if (passes().length === 0) {
                      <p class="hint">No passes yet. Add one, or go straight to narration with the book as it is.</p>
                    }

                    <!-- A refusal that names no pass (no PDF, no book EPUB) belongs to
                         the run as a whole, not to a row. -->
                    @if (chainError() && chainErrorAt() < 0) {
                      <div class="pass-error">{{ chainError() }}</div>
                    }

                    @for (pass of passes(); track pass.uid; let i = $index) {
                      <div class="pass-card" [class.invalid]="chainErrorAt() === i">
                        <div class="pass-card-head">
                          <span class="pass-index">{{ i + 1 }}</span>
                          <span class="pass-name">{{ passLabel(pass) }}</span>
                          <button type="button" class="pass-btn" title="Move up" [disabled]="i === 0" (click)="movePass(i, -1)">↑</button>
                          <button type="button" class="pass-btn" title="Move down" [disabled]="i === passes().length - 1" (click)="movePass(i, 1)">↓</button>
                          <button
                            type="button"
                            class="pass-btn remove"
                            [disabled]="passLocked(pass)"
                            [title]="passLocked(pass) ? ocrRequiredReason() : 'Remove'"
                            (click)="removePass(i)"
                          >✕</button>
                        </div>
                        @if (passDetail(pass)) {
                          <span class="pass-detail">{{ passDetail(pass) }}</span>
                        }
                        @if (passLocked(pass)) {
                          <span class="pass-detail">{{ ocrRequiredReason() }}</span>
                        }
                        @if (chainErrorAt() === i) {
                          <div class="pass-error">{{ chainError() }}</div>
                        }
                      </div>
                    }

                    @if (passes().length > 0) {
                      @if (planning()) {
                        <span class="hint">Checking this order…</span>
                      } @else if (!chainError() && chainPlan()) {
                        <span class="hint">
                          {{ chainPlan()!.producesEpub
                            ? 'Rebuilds the book EPUB from the scanned pages.'
                            : 'Rewrites the book EPUB in place, one pass at a time.' }}
                        </span>
                      }
                    }
                  </div>
                </div>
              } @else {
                <h3>AI Cleanup</h3>
                <p class="step-desc">Clean up OCR artifacts and formatting issues using AI.</p>

                <!-- No AI configured → gray out behind a layover that links to the wizard -->
                @if (ai.checkedOnce() && !ai.available()) {
                  <div class="ai-layover">
                    <div class="ai-layover-card">
                      <div class="ai-layover-icon">&#129302;</div>
                      <h4>AI isn't set up yet</h4>
                      <p>Use the AI Setup wizard to enable cleanup &amp; simplify — add a bundled local model, connect Ollama, or save a Claude/OpenAI key.</p>
                      <button class="ai-layover-btn" (click)="openAiSetup()">Open AI Setup wizard</button>
                    </div>
                  </div>
                }

                <!-- Existing cleanup notice -->
                @if (hasExistingCleanup()) {
                  <div class="existing-cleanup-banner">
                    <span>Previous cleanup found. Running again will resume where it left off.</span>
                    <button class="start-over-btn" (click)="clearCleanupStage()">Start Over</button>
                  </div>
                }

                <!-- Source EPUB Selection -->
                <div class="config-section">
                  <label class="field-label">Source EPUB</label>
                  <div class="source-stages">
                    @for (stage of cleanupSourceStages(); track stage.id) {
                      <button
                        class="stage-btn"
                        [class.selected]="isStageSelected('cleanup', stage)"
                        [class.completed]="stage.completed"
                        [disabled]="!stage.completed"
                        (click)="selectStage('cleanup', stage)"
                      >
                        {{ stage.label }}
                        @if (stage.completed) {
                          <span class="stage-check">&#10003;</span>
                        }
                      </button>
                    }
                  </div>
                </div>

                <!-- AI Model — unified selector: only configured sources, grouped by provider -->
                <div class="config-section">
                  <label class="field-label">AI Model</label>
                  @if (aiSourceGroups().length > 0) {
                    <desktop-select
                      class="select-input"
                      [options]="aiModelGroups()"
                      [ngModel]="cleanupSelection()"
                      (ngModelChange)="onCleanupModelChange($event)"
                    />
                  } @else {
                    <div class="no-models">
                      @if (checkingConnection()) {
                        Checking for available AI…
                      } @else {
                        <span class="error-text">No AI configured.</span> Set up a local model, Ollama, or an API key.
                      }
                    </div>
                  }
                  @if (!allAiConfigured()) {
                    <button class="configure-ai-btn" (click)="openAiSetup()">⚙ Configure AI</button>
                  }
                </div>

                <!-- Start Fresh / Use Existing removed — source picker handles input selection,
                     backend always overwrites output (startFresh defaults to true) -->

                <!-- Processing Options -->
                <div class="processing-options">
                  <label class="field-label">Processing Options</label>

                  <!-- AI Cleanup Option -->
                  <div class="toggle-section-inline">
                    <button
                      class="option-toggle"
                      [class.active]="enableAiCleanup()"
                      (click)="toggleAiCleanup()"
                    >
                      <span class="toggle-icon">🔧</span>
                      <span class="toggle-label">AI Cleanup</span>
                      <span class="toggle-sublabel">Fix OCR errors & formatting</span>
                    </button>

                    <!-- Simplify for Language Learning Option -->
                    <button
                      class="option-toggle"
                      [class.active]="simplifyForLearning()"
                      (click)="toggleSimplify()"
                    >
                      <span class="toggle-icon">📖</span>
                      <span class="toggle-label">Simplify</span>
                      <span class="toggle-sublabel">Rewrite into clearer English</span>
                    </button>
                  </div>

                  <!-- The two cleanup passes are independent products, so they are picked
                       explicitly rather than inferred. Defaulted from the project's ORIGINAL
                       source (PDF → Both, anything born-digital → TTS only) and left to the
                       user from there. -->
                  @if (enableAiCleanup() && simplifyForLearning()) {
                    <div class="ocr-repair-note">
                      Cleanup + Simplify runs as one rewrite pass, where the two stages can't be
                      separated. Turn Simplify off to choose between them.
                    </div>
                  }
                  @if (enableAiCleanup() && !simplifyForLearning()) {
                    <div class="simplify-mode-selector">
                      <label class="field-label">
                        Cleanup stages
                        <span class="stage-origin">{{ ocrRepairOriginHint() }}</span>
                      </label>
                      <div class="mode-options">
                        @for (opt of cleanupStageOptions; track opt.value) {
                          <button
                            type="button"
                            class="mode-option"
                            [class.active]="cleanupStages() === opt.value"
                            (click)="selectCleanupStages(opt.value)"
                          >
                            <span class="mode-label">{{ opt.label }}</span>
                            <span class="mode-desc">{{ opt.desc }}</span>
                          </button>
                        }
                      </div>

                    </div>
                  }

                  @if (simplifyForLearning()) {
                    <div class="simplify-mode-selector">
                      <label class="field-label">Simplify mode</label>
                      <div class="mode-options">
                        @for (opt of simplifyModeOptions; track opt.value) {
                          <button
                            type="button"
                            class="mode-option"
                            [class.active]="simplifyMode() === opt.value"
                            (click)="simplifyMode.set(opt.value)"
                          >
                            <span class="mode-label">{{ opt.label }}</span>
                            <span class="mode-desc">{{ opt.desc }}</span>
                          </button>
                        }
                      </div>
                    </div>
                  }

                  @if (!enableAiCleanup() && !simplifyForLearning()) {
                    <div class="warning-banner">
                      No processing selected. Enable at least one option or skip this step.
                    </div>
                  }
                </div>

                <!-- Custom Instructions -->
                <div class="config-section">
                  <label class="field-label">Custom Instructions</label>
                  <textarea
                    class="custom-instructions"
                    [value]="customInstructions()"
                    (input)="customInstructions.set($any($event.target).value)"
                    placeholder="Optional: Add specific instructions for the AI (e.g., 'Format numbered lists with periods at the end of each item')"
                    rows="3"
                  ></textarea>
                  <span class="hint">Appended to the AI prompt for both cleanup and simplify</span>
                </div>

                <!-- AI Prompt Editor -->
                <div class="accordion" [class.open]="promptAccordionOpen()">
                  <button class="accordion-header" (click)="togglePromptAccordion()">
                    <span class="accordion-title">AI Prompt</span>
                    <span class="accordion-icon">{{ promptAccordionOpen() ? '▼' : '▶' }}</span>
                  </button>
                  @if (promptAccordionOpen()) {
                    <div class="accordion-content">
                      @if (loadingPrompt()) {
                        <div class="hint">Loading prompt...</div>
                      } @else {
                        <textarea
                          class="prompt-textarea"
                          [value]="promptText()"
                          (input)="onPromptChange($event)"
                          placeholder="Enter the AI cleanup prompt..."
                        ></textarea>
                        @if (promptModified()) {
                          <div class="prompt-footer">
                            <button class="btn-save-prompt" [disabled]="savingPrompt()" (click)="savePrompt()">
                              {{ savingPrompt() ? 'Saving...' : 'Save Prompt' }}
                            </button>
                          </div>
                        }
                      }
                    </div>
                  }
                </div>

                <!-- Sentence-aligned translation: one EPUB per target language,
                     which is what the interleaved assembly pairs up. -->
                <h3>Translation</h3>
                <p class="step-desc">Select target languages for a bilingual audiobook. Multiple selections allowed.</p>

                <div class="config-section">
                  <label class="field-label">Source EPUB</label>
                  <div class="source-stages">
                    @for (stage of translateSourceStages(); track stage.id) {
                      <button
                        class="stage-btn"
                        [class.selected]="isStageSelected('translate', stage)"
                        [class.completed]="stage.completed"
                        [disabled]="!stage.completed"
                        (click)="selectStage('translate', stage)"
                      >
                        {{ stage.label }}
                        @if (stage.completed) {
                          <span class="stage-check">&#10003;</span>
                        }
                      </button>
                    }
                  </div>
                </div>

                <div class="config-section">
                  <label class="field-label">AI Model</label>
                  @if (aiSourceGroups().length > 0) {
                    <desktop-select
                      class="select-input"
                      [options]="aiModelGroups()"
                      [ngModel]="translateSelection()"
                      (ngModelChange)="onTranslateModelChange($event)"
                    />
                  } @else {
                    <div class="no-models">
                      @if (checkingConnection()) {
                        Checking for available AI…
                      } @else {
                        <span class="error-text">No AI configured.</span> Set up a local model, Ollama, or an API key.
                      }
                    </div>
                  }
                </div>

                <div class="config-section">
                  <label class="field-label">Custom Instructions</label>
                  <textarea
                    class="custom-instructions"
                    [value]="translateCustomInstructions()"
                    (input)="translateCustomInstructions.set($any($event.target).value)"
                    placeholder="Optional: Add specific instructions for the AI (e.g., 'If you encounter English text, return it unchanged')"
                    rows="3"
                  ></textarea>
                  <span class="hint">Appended to the translation prompt for each batch</span>
                </div>

                <div class="source-lang-display">
                  <span class="label">Detected source language:</span>
                  <span class="value">{{ getLanguageName(detectedSourceLang()) }}</span>
                </div>

                <div class="config-section">
                  <label class="field-label">Target Languages (select multiple)</label>
                  <div class="language-grid">
                    @for (lang of supportedLanguages; track lang.code) {
                      @if (lang.code !== detectedSourceLang()) {
                        <button
                          class="language-btn"
                          [class.selected]="isTargetLangSelected(lang.code)"
                          (click)="toggleTargetLang(lang.code)"
                        >
                          <span class="lang-flag" [style.background]="getFlagCss(lang.code)"></span>
                          <span class="lang-code">{{ lang.code.toUpperCase() }}</span>
                          <span class="lang-name">{{ lang.name }}</span>
                          @if (isTargetLangSelected(lang.code)) {
                            <span class="lang-check">✓</span>
                          }
                        </button>
                      }
                    }
                  </div>

                  @if (targetLangs().size === 0) {
                    <div class="hint">Select at least one target language, or leave empty to use existing translations.</div>
                  } @else {
                    <div class="selection-summary">
                      Selected: {{ Array.from(targetLangs()).map(getLanguageName.bind(this)).join(', ') }}
                    </div>
                  }
                </div>

                @if (existingTranslationEpubs().length > 0) {
                  <div class="config-section">
                    <label class="field-label">Existing Translations</label>
                    <div class="existing-translations">
                      @for (epub of existingTranslationEpubs(); track epub.path) {
                        <div class="existing-translation-row">
                          <span class="existing-translation-label">{{ epub.lang.toUpperCase() }} — {{ getLanguageName(epub.lang) }}</span>
                          <button class="existing-translation-delete" (click)="deleteTranslationEpub(epub)">Delete</button>
                        </div>
                      }
                      @if (existingTranslationEpubs().length > 1) {
                        <button class="existing-translation-clear-all" (click)="deleteAllTranslationEpubs()">Clear All Translations</button>
                      }
                    </div>
                  </div>
                }
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 3: TTS -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('tts') {
            <div class="step-panel scrollable">
              <h3>Text-to-Speech</h3>
              <p class="step-desc">
                @if (pipelineMode() === 'mono') {
                  Configure the narration voice.
                } @else {
                  Configure voice synthesis for each language. Each row becomes a separate TTS job.
                }
              </p>

              <!-- Narration reads an EPUB. If the project has none and this run
                   produces none, there is nothing to narrate — say so once and stop,
                   rather than collecting settings for a job that cannot be queued. -->
              @if (ttsBlockedReason(); as why) {
                <div class="step-blocked">{{ why }}</div>
              }
              @if (!ttsBlockedReason()) {

              <!-- Stanza segmentation packs for the NARRATION languages. Translation
                   itself is the AI's job (no stanza); sentence segmentation for TTS
                   needs the pack. Only genuinely-missing packs appear here. -->
              @if (missingTtsLanguagePacks().length > 0) {
                <div class="lang-gate">
                  <div class="lang-gate-head">
                    <span class="lang-gate-icon">🌍</span>
                    <div>
                      <h4>Language pack needed for narration</h4>
                      <p>TTS splits text into sentences per language using a Stanza pack. Download the pack(s) for the language(s) you’re narrating so it works offline.</p>
                    </div>
                  </div>
                  <div class="lang-gate-list">
                    @for (lang of missingTtsLanguagePacks(); track lang.code) {
                      <div class="lang-gate-row">
                        <span class="lang-gate-name">{{ lang.name }}</span>
                        @if (lang.installing) {
                          <div class="lang-gate-progress"><div class="lang-gate-bar" [style.width.%]="lang.pct"></div></div>
                          <button class="lang-gate-btn ghost" (click)="langPacks.cancel(lang.code)">Cancel</button>
                        } @else {
                          <button class="lang-gate-btn" [disabled]="langPacks.isBusy(lang.code)" (click)="langPacks.install(lang.code)">Download</button>
                        }
                      </div>
                    }
                  </div>
                  <button class="lang-gate-link" (click)="openLanguageSettings()">Manage all languages…</button>
                </div>
              }

              <!-- Continue / New Toggle -->
              <div class="config-section">
                <label class="field-label">Mode</label>
                <div class="provider-buttons">
                  <button class="provider-btn"
                    [class.selected]="!continueTts()"
                    (click)="setNewMode()">
                    <span class="provider-name">New</span>
                    <span class="provider-status">Start fresh</span>
                  </button>
                  <button class="provider-btn"
                    [class.selected]="continueTts()"
                    [disabled]="!partialTtsSessions().length"
                    (click)="partialTtsSessions().length && activateContinue()">
                    <span class="provider-name">Continue</span>
                    <span class="provider-status">
                      @if (partialTtsSessions().length) {
                        {{ partialTtsSessions().length }} partial session{{ partialTtsSessions().length > 1 ? 's' : '' }}
                      } @else {
                        No partial sessions
                      }
                    </span>
                  </button>
                </div>
              </div>

              @if (continueTts()) {
              <!-- Continue mode: show partial session info -->
              <div class="config-section">
                @for (session of partialTtsSessions(); track session.language) {
                  <div class="hint" style="margin-bottom: 4px;">
                    {{ session.language.toUpperCase() }}: {{ session.completedSentences }}/{{ session.totalSentences }} sentences
                  </div>
                }
                <span class="hint">
                  Resuming your earlier session. The settings below are pre-filled with what that run used — change anything before you continue.
                </span>
              </div>
              }

              @if (showTtsSettings()) {

              <!-- Pipeline preset: a saved bundle of engine + voice + sampling +
                   RVC enhancement. Picking one configures every control below at
                   once; hand-editing any control flips it back to "Custom". -->
              @if (pipelineMode() === 'mono') {
                <div class="config-section preset-section">
                  <label class="field-label">Pipeline preset</label>
                  @if (pipelinePresets().length > 0) {
                    <div class="preset-row">
                      <desktop-select
                        class="select-input preset-select"
                        placeholder="Custom settings"
                        [options]="presetOptions()"
                        [ngModel]="selectedPresetId()"
                        (ngModelChange)="applyPreset($event)"
                      />
                      @if (selectedPresetId() && !selectedPresetIsBuiltin()) {
                        <button type="button" class="preset-delete"
                                title="Delete this preset" aria-label="Delete preset"
                                (click)="deleteSelectedPreset()">✕</button>
                      }
                    </div>
                  }
                  <div class="preset-actions">
                    <a class="download-more-link" (click)="saveCurrentAsPreset()">＋ Save current setup as a preset…</a>
                    @if (pipelinePresets().length === 0) {
                      <span class="hint">Save your voice + enhancement setup here to reuse it on the next book.</span>
                    }
                  </div>
                </div>
              }

              <!-- TTS Engine Selection -->
              <div class="config-section">
                <label class="field-label">TTS Engine</label>
                <div class="provider-buttons">
                  @for (eng of engineList; track eng.id) {
                    @if (engineAvailable(eng)) {
                      <button
                        class="provider-btn"
                        [class.selected]="ttsEngine() === eng.id"
                        (click)="selectTtsEngine(eng.id)"
                      >
                        <span class="provider-name">{{ eng.displayName }}</span>
                        <span class="provider-status">{{ eng.statusText }}</span>
                      </button>
                    }
                  }
                </div>
              </div>

              <!-- Device Selection — hidden for Mac + Orpheus, which always runs on the
                   Apple Silicon GPU via MLX (the device arg doesn't gate MLX, so an
                   Auto/CPU/GPU choice here would be meaningless). The Performance level
                   below is the real Mac Orpheus knob. -->
              @if (!(isMac && ttsEngine() === 'orpheus')) {
                <div class="config-section">
                  <label class="field-label">Processing Device</label>
                  <div class="provider-buttons">
                    <button class="provider-btn" [class.selected]="ttsDevice() === 'auto'" (click)="ttsDevice.set('auto')">
                      <span class="provider-name">Auto</span>
                      <span class="provider-status">Best available</span>
                    </button>
                    @if (currentCaps().device.cpuCapable) {
                      <button class="provider-btn" [class.selected]="ttsDevice() === 'cpu'" (click)="ttsDevice.set('cpu')">
                        <span class="provider-name">CPU</span>
                      </button>
                    }
                    @if (isMac) {
                      <button class="provider-btn" [class.selected]="ttsDevice() === 'mps'" (click)="ttsDevice.set('mps')">
                        <span class="provider-name">GPU</span>
                        <span class="provider-status">Apple Silicon (MPS)</span>
                      </button>
                    } @else {
                      <button class="provider-btn" [class.selected]="ttsDevice() === 'gpu'" (click)="ttsDevice.set('gpu')">
                        <span class="provider-name">GPU</span>
                        <span class="provider-status">CUDA</span>
                      </button>
                    }
                  </div>
                  <p class="device-hint">{{ deviceHint() }}</p>
                </div>
              }

              <!-- Orpheus performance level — Auto self-sizes per-job at launch; a manual
                   level is honored verbatim. On NVIDIA this trades GPU memory; on Mac it
                   trades unified memory + batch width (how many sentences generate at
                   once). Only relevant for Orpheus; shown on both NVIDIA and Mac. -->
              @if (ttsEngine() === 'orpheus') {
                <div class="config-section">
                  <label class="field-label">{{ orpheusMemPlatform() === 'mac' ? 'Performance' : 'GPU memory' }}</label>
                  <div class="provider-buttons">
                    @for (t of orpheusMemTiers; track t.id) {
                      <button
                        class="provider-btn"
                        [class.selected]="orpheusMemTier() === t.id"
                        (click)="setOrpheusMemTier(t.id)"
                      >
                        <span class="provider-name">{{ t.name }}</span>
                        <span class="provider-status">{{ t.sub }}</span>
                      </button>
                    }
                  </div>
                  @if (!orpheusMemViable()) {
                    <p class="device-warning">
                      ⚠ Only {{ ((orpheusMemFreeMB() ?? 0) / 1024) | number:'1.1-1' }} GB of GPU memory is free right now — very low. Orpheus will run at its lowest level and may run out of memory. Close GPU-heavy apps (extra browser tabs, games, video), or run this job on the processor.
                    </p>
                  }
                  <p class="device-hint">
                    @if (orpheusMemPlatform() === 'mac') {
                      @if (orpheusMemTier() === 'auto') {
                        Auto sizes Orpheus to your Mac's memory — more memory lets it generate more sentences at once (faster).{{ orpheusMemResolved() ? ' Currently: ' + orpheusMemResolvedName() + '.' : '' }} Orpheus always runs on the Apple Silicon GPU.
                      } @else {
                        Higher levels generate more sentences at once (faster) but claim more of your Mac's unified memory, leaving less for other apps — <b>Extreme</b> is best when the Mac is otherwise idle. Applies to your next job.
                      }
                    } @else {
                      @if (orpheusMemTier() === 'auto') {
                        Auto sizes Orpheus to your graphics card at launch and leaves the rest free for the browser and desktop; when the card is idle (overnight runs) it uses the top level.
                      } @else {
                        Higher levels give Orpheus more GPU memory (faster) but leave less for everything else — <b>Extreme</b> is best when nothing else needs the card (overnight); it can starve the browser mid-job on a busy desktop. Applies to your next job.
                      }
                      @if (orpheusMemReserveMB() != null && orpheusMemFreeMB() != null) {
                        <span> {{ orpheusMemResolved() ? (orpheusMemResolved() + ' — ') : '' }}uses about <b>{{ gb(orpheusMemReserveMB()) }} GB</b>, leaving <b>{{ gb(orpheusMemFreeMB()! - (orpheusMemReserveMB() ?? 0)) }} GB</b> free ({{ gb(orpheusMemFreeMB()) }} GB free now).</span>
                      }
                    }
                  </p>
                </div>
              }

              <!-- Parallel Workers (XTTS only) — shown only when the user has
                   enabled the multi-worker capability AND the job won't run on the
                   GPU (CUDA serializes to one worker, so parallel does nothing). -->
              @if (currentCaps().maxWorkers > 1 && workerCfg.enabled() && !ttsUsesGpu()) {
                <div class="config-section">
                  <label class="field-label">Parallel Workers</label>
                  <div class="worker-options">
                    @for (count of [1, 2, 3, 4]; track count) {
                      <button class="worker-btn" [class.selected]="ttsWorkers() === count" (click)="setTtsWorkers(count)">
                        {{ count }}
                      </button>
                    }
                  </div>
                  <span class="hint">More workers = faster, but uses ~5GB RAM each. Default from Settings.</span>
                </div>
              }

              @if (pipelineMode() === 'mono') {
                <!-- What gets narrated. Two answers only: the book as it is on disk,
                     or the book this run's passes produce. A pass rewrites the book
                     in place, so "as it is" is not on offer while passes are queued —
                     it would name the same file and mean something else. -->
                <div class="config-section">
                  <label class="field-label">Narrate</label>
                  <div class="variant-cards">
                    <button
                      type="button"
                      class="variant-card"
                      [class.selected]="ttsInput() === 'book'"
                      [disabled]="!bookEpubPath() || passes().length > 0"
                      (click)="ttsInput.set('book')"
                    >
                      <span class="variant-format">EPUB</span>
                      <span class="variant-title">The book as it is</span>
                      <span class="variant-file">{{ bookEpubPath() ? getFilenameFromPath(bookEpubPath()!) : 'not exported yet' }}</span>
                      @if (bookEpubPath() && passes().length > 0) {
                        <span class="variant-note">The passes rewrite this file.</span>
                      }
                    </button>
                    <button
                      type="button"
                      class="variant-card"
                      [class.selected]="ttsInput() === 'run'"
                      [disabled]="!runProducesEpub()"
                      (click)="ttsInput.set('run')"
                    >
                      <span class="variant-format">EPUB</span>
                      <span class="variant-title">What this run produces</span>
                      <span class="variant-file">{{ runProducesEpub() ? getFilenameFromPath(chainPlan()!.bookEpubPath) : 'no passes configured' }}</span>
                    </button>
                  </div>
                </div>

                <!-- Single Voice -->
                <div class="config-section">
                  <label class="field-label">Voice ({{ getLanguageName(monoTtsLanguage()) }})</label>
                  <desktop-select
                    class="select-input"
                    [options]="voiceOptions()"
                    [ngModel]="monoTtsVoice()"
                    (ngModelChange)="monoTtsVoice.set($event)"
                  />
                  @if (currentCaps().voices.canDownloadMore) {
                    <a class="download-more-link" (click)="goToVoiceDownloads()">＋ Download more voices…</a>
                  }
                </div>

                <!-- Speed -->
                <div class="config-section">
                  <label class="field-label">Speed: {{ monoTtsSpeed() }}x</label>
                  <input
                    type="range"
                    class="full-width-slider"
                    min="0.5"
                    max="2"
                    step="0.05"
                    [value]="monoTtsSpeed()"
                    (input)="monoTtsSpeed.set(+$any($event.target).value)"
                  />
                </div>

                @if (showAdvancedSampling()) {
                <!-- Advanced (XTTS sampling) -->
                <div class="accordion" [class.open]="advancedTtsOpen()">
                  <button class="accordion-header" (click)="advancedTtsOpen.set(!advancedTtsOpen())">
                    <span class="accordion-title">Advanced</span>
                    <span class="accordion-icon">{{ advancedTtsOpen() ? '▼' : '▶' }}</span>
                  </button>
                  @if (advancedTtsOpen()) {
                    <div class="accordion-content">
                      <div class="config-section">
                        <label class="field-label">Temperature: {{ ttsTemperature() }}</label>
                        <input type="range" class="full-width-slider" min="0.1" max="1.0" step="0.05"
                          [value]="ttsTemperature()" (input)="ttsTemperature.set(+$any($event.target).value)" />
                      </div>
                      <div class="config-section">
                        <label class="field-label">Top P: {{ ttsTopP() }}</label>
                        <input type="range" class="full-width-slider" min="0.1" max="1.0" step="0.05"
                          [value]="ttsTopP()" (input)="ttsTopP.set(+$any($event.target).value)" />
                      </div>
                      <div class="config-section">
                        <label class="field-label">Repetition penalty: {{ ttsRepetitionPenalty() }}</label>
                        <input type="range" class="full-width-slider" min="1" max="10" step="0.5"
                          [value]="ttsRepetitionPenalty()" (input)="ttsRepetitionPenalty.set(+$any($event.target).value)" />
                        <span class="hint">Higher discourages looping/garbled output. Stock XTTS is {{ stockRepetitionPenalty }}.</span>
                      </div>
                      <div class="config-section reset-row">
                        <span class="hint">Your changes are saved as the defaults for next time.</span>
                        <button type="button" class="reset-stock-btn" (click)="resetTtsToStock()">Reset to stock</button>
                      </div>
                    </div>
                  }
                </div>
                }
              } @else {
              <!-- Language Rows -->
              <div class="config-section">
                <label class="field-label">Languages to Generate</label>

                <div class="language-rows">
                  @for (row of ttsLanguageRows(); track row.id; let i = $index) {
                    <div class="language-row">
                      <desktop-select
                        class="lang-select"
                        [options]="ttsLanguageOptions()"
                        [ngModel]="row.language"
                        (ngModelChange)="updateTtsRow(i, 'language', $event)"
                      />

                      <!-- EPUB automatically resolved at runtime based on language -->
                      <span class="epub-auto">
                        {{ row.language.toUpperCase() }}.epub
                      </span>

                      <desktop-select
                        class="voice-select"
                        [options]="voiceOptions()"
                        [ngModel]="row.voice"
                        (ngModelChange)="updateTtsRow(i, 'voice', $event)"
                      />

                      <input
                        type="range"
                        class="speed-slider"
                        min="0.5"
                        max="2"
                        step="0.05"
                        [value]="row.speed"
                        (input)="updateTtsRow(i, 'speed', +$any($event.target).value)"
                      />
                      <span class="speed-label">{{ row.speed }}x</span>

                      <button class="remove-row-btn" (click)="removeTtsRow(i)" [disabled]="ttsLanguageRows().length <= 1">
                        ✕
                      </button>
                    </div>
                  }
                </div>

                <button class="add-row-btn" (click)="addTtsRow()">
                  + Add Language
                </button>
              </div>
              }
              }
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 3: Assembly -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('assembly') {
            <div class="step-panel">
              @if (assemblyBlockedReason(); as why) {
                <h3>Enhance &amp; Assemble</h3>
                <div class="step-blocked">{{ why }}</div>
              } @else if (pipelineMode() === 'mono') {
                <h3>Enhance &amp; Assemble</h3>
                <p class="step-desc">Optionally re-render the narration through an RVC voice, then assemble the audio into a finished audiobook (M4B with chapters).</p>

                <!-- Final-audio denoise: block-based roformer pass over the rendered
                     sentences, run BEFORE any RVC pass (listed first to match the
                     execution order: denoise → RVC → assembly). Cheap next to the
                     full RVC resynthesis below. Defaults ON for Orpheus (its voices
                     are trained on a faint hiss bed the render reproduces), OFF
                     otherwise. -->
                <div class="config-section">
                  <label class="field-label">
                    <input type="checkbox" [checked]="finalDenoise()"
                           (change)="finalDenoiseOverride.set($any($event.target).checked)" />
                    Denoise final audio
                  </label>
                  <span class="hint">Removes the faint background hiss that hiss-bed-trained voices (Orpheus) reproduce. Applied once during final assembly. For deeper cleanup use RVC enhancement.</span>
                </div>

                <!-- De-ring: apply the session voice's per-voice post-render filter
                     (notch/comb) at the final assembly encode to remove SNAC tonal
                     ringing. OPT-IN, default OFF — the backend resolves the chain from
                     the session's Orpheus provenance ONLY when this is ticked. -->
                <div class="config-section">
                  <label class="field-label">
                    <input type="checkbox" [checked]="applyDeRing()"
                           (change)="applyDeRing.set($any($event.target).checked)" />
                    De-ring (remove tonal ringing)
                  </label>
                  <span class="hint">Only needed when you hear a faint metallic ringing or whistle in the narration. Applies the voice's tuned notch filter at final assembly. Leave off unless you can hear ringing — over-applying can dull sibilants. Orpheus sessions only.</span>
                </div>

                <!-- Voice Enhancement (RVC): re-render the narration through a matching
                     RVC voice (post-TTS, pre-assembly) to smooth synthetic artifacts.
                     Operates on the cached XTTS sentences, so it can be re-run with a
                     different voice. Only shown when the engine is installed. -->
                @if (componentService.isInstalled('rvc-env')) {
                  <div class="config-section">
                    <label class="field-label">
                      <input type="checkbox" [checked]="rvcEnhanceEnabled()"
                             (change)="rvcEnhanceEnabled.set($any($event.target).checked)" />
                      Enhance voice (RVC)
                    </label>
                    <span class="hint">Re-render the narration through a matching RVC voice to smooth out synthetic artifacts. Pick a voice close to your TTS voice — RVC keeps the original's content &amp; pitch.</span>
                    @if (rvcEnhanceEnabled()) {
                      @if (installedRvcVoices().length > 0) {
                        <desktop-select
                          class="select-input"
                          placeholder="Choose an enhancement voice…"
                          [options]="rvcVoiceOptions()"
                          [ngModel]="rvcEnhanceVoiceId()"
                          (ngModelChange)="rvcEnhanceVoiceId.set($event)"
                        />
                      } @else {
                        <span class="hint">No enhancement voices installed yet.</span>
                      }
                      <a class="download-more-link" (click)="goToEnhancementDownloads()">＋ Download more enhancement voices…</a>

                      @if (rvcEnhanceVoiceId()) {
                        <div class="config-section">
                          <label class="field-label">Index rate: {{ rvcEnhanceIndexRate() }}</label>
                          <input type="range" class="full-width-slider" min="0" max="1" step="0.05"
                            [value]="rvcEnhanceIndexRate()" (input)="rvcEnhanceIndexRate.set(+$any($event.target).value)" />
                          <span class="hint">How strongly to lean on the model's timbre. Lower keeps more of your narration; higher pushes toward the model. Index-less voices ignore this.</span>
                        </div>
                        <div class="config-section">
                          <label class="field-label">Protect rate: {{ rvcEnhanceProtectRate() }}</label>
                          <input type="range" class="full-width-slider" min="0" max="0.5" step="0.05"
                            [value]="rvcEnhanceProtectRate()" (input)="rvcEnhanceProtectRate.set(+$any($event.target).value)" />
                          <span class="hint">Protects consonants &amp; breaths from being over-converted. Higher preserves more of the original; 0.5 is a safe default.</span>
                        </div>
                        <div class="config-section">
                          <label class="field-label">Pitch shift: {{ rvcEnhanceNSemitones() }} semitones</label>
                          <input type="range" class="full-width-slider" min="-24" max="12" step="1"
                            [value]="rvcEnhanceNSemitones()" (input)="rvcEnhanceNSemitones.set(+$any($event.target).value)" />
                          <span class="hint">Shifts the converted voice up/down. 0 keeps the source pitch. Drop to about −12 to −15 to bring a high female voice into a male model's range.</span>
                        </div>
                      }
                    }
                  </div>
                } @else {
                  <!-- Engine not downloaded → say so, and point at the download. -->
                  <div class="config-section">
                    <label class="field-label">Enhance voice (RVC)</label>
                    <span class="hint">Voice enhancement isn't available because the RVC engine isn't installed.
                      <a class="download-more-link" (click)="goToEnhancementDownloads()">Download it in Settings → Voice Enhancement</a>
                      to re-render the narration through a matching voice.
                    </span>
                  </div>
                }

                @if (ttsInThisRun()) {
                  <!-- Mode A: TTS is enabled — assembly chains from THIS run's fresh TTS output -->
                  <div class="review-card">
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">This run's new TTS output{{ rvcEnhanceEnabled() && rvcEnhanceVoiceId() ? ' → RVC ' + rvcVoiceLabel(rvcEnhanceVoiceId()) : '' }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Status:</span>
                        <span class="review-value">Will run after TTS completes</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Title:</span>
                        <span class="review-value">{{ title() || 'Untitled' }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Author:</span>
                        <span class="review-value">{{ author() || 'Unknown' }}</span>
                      </div>
                    </div>
                  </div>
                } @else if (cachedSession(); as session) {
                  <!-- Mode B: TTS skipped, cached session exists — reassemble the CACHED files -->
                  <div class="review-card">
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">Cached files{{ rvcEnhanceEnabled() && rvcEnhanceVoiceId() ? ' → RVC ' + rvcVoiceLabel(rvcEnhanceVoiceId()) : '' }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Originally made with:</span>
                        <span class="review-value">{{ formatProvenance(session.provenance) }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Progress:</span>
                        <span class="review-value">{{ session.completedSentences }}/{{ session.totalSentences }} sentences</span>
                      </div>
                      @if (session.chapters?.length) {
                        <div class="review-row">
                          <span class="review-label">Chapters:</span>
                          <span class="review-value">{{ session.chapters.length }}</span>
                        </div>
                      }
                    </div>
                  </div>

                  <!-- Raw-sentence audition: play through the cached sentences to judge
                       which of the three passes above are needed. RAW audio only — no
                       processed preview (denoise/RVC are GPU, never run here). Shown
                       only when the cache is auditionable (numeric {i}.flac + text);
                       legacy/unrecorded sessions fall through to the toggles alone. -->
                  @if (auditionSession(); as audition) {
                    <div class="audition-block">
                      <div class="audition-head">Audition the raw narration</div>
                      <p class="hint">Play the unprocessed sentences and tick the passes above only where you hear a problem. This preview is always the raw audio — de-ring, denoise and RVC are applied at assembly, not here.</p>
                      <app-assemble-audition-player [session]="audition" />
                    </div>
                  } @else if (auditionLoading()) {
                    <p class="hint">Loading sentences to audition…</p>
                  }
                } @else {
                  <div class="warning-banner">
                    No cached TTS session found for this book. Enable TTS to chain assembly, or skip this step.
                  </div>
                }
              } @else {
              <h3>Bilingual Assembly</h3>
              <p class="step-desc">Interleave source and target sentences into a bilingual audiobook.</p>

              <!-- Available Sessions -->
              <div class="config-section">
                <label class="field-label">Source Sentences</label>
                <desktop-select
                  class="select-input"
                  [options]="assemblySourceOptions()"
                  [ngModel]="assemblySourceLang()"
                  (ngModelChange)="setAssemblySourceLang($event)"
                />
              </div>

              <div class="config-section">
                <label class="field-label">Target Sentences</label>
                <desktop-select
                  class="select-input"
                  [options]="assemblyTargetOptions()"
                  [ngModel]="assemblyTargetLang()"
                  (ngModelChange)="setAssemblyTargetLang($event)"
                />
              </div>

              <!-- Assembly Pattern -->
              <div class="config-section">
                <label class="field-label">Assembly Pattern</label>
                <div class="provider-buttons">
                  <button
                    class="provider-btn"
                    [class.selected]="assemblyPattern() === 'interleaved'"
                    (click)="assemblyPattern.set('interleaved')"
                  >
                    <span class="provider-name">Interleaved</span>
                    <span class="provider-status">EN-DE-EN-DE...</span>
                  </button>
                  <button
                    class="provider-btn"
                    [class.selected]="assemblyPattern() === 'sequential'"
                    (click)="assemblyPattern.set('sequential')"
                  >
                    <span class="provider-name">Sequential</span>
                    <span class="provider-status">All EN then all DE</span>
                  </button>
                </div>
              </div>

              <!-- Pause Duration -->
              <div class="config-section">
                <label class="field-label">Pause between sentences: {{ pauseDuration() }}s</label>
                <input
                  type="range"
                  class="full-width-slider"
                  min="0"
                  max="2"
                  step="0.1"
                  [value]="pauseDuration()"
                  (input)="pauseDuration.set(+$any($event.target).value)"
                />
              </div>

              <!-- Gap Duration -->
              <div class="config-section">
                <label class="field-label">Gap between pairs: {{ gapDuration() }}s</label>
                <input
                  type="range"
                  class="full-width-slider"
                  min="0"
                  max="3"
                  step="0.1"
                  [value]="gapDuration()"
                  (input)="gapDuration.set(+$any($event.target).value)"
                />
              </div>
              }

              <!-- Output Format (shared by both pipelines) -->
              @if (!assemblyBlockedReason() && (pipelineMode() === 'bilingual' || ttsInThisRun() || cachedSession())) {
              <div class="config-section">
                <label class="field-label">Output Format</label>
                <div class="provider-buttons">
                  <button class="provider-btn selected" disabled>
                    <span class="provider-name">Audio</span>
                    <span class="provider-status">M4B + VTT (always)</span>
                  </button>
                  <button class="provider-btn"
                    [class.selected]="generateVideo()"
                    (click)="generateVideo.set(!generateVideo())">
                    <span class="provider-name">Video</span>
                    <span class="provider-status">MP4 with subtitles</span>
                  </button>
                </div>
              </div>
              }

              @if (generateVideo()) {
                <div class="config-section">
                  <label class="field-label">Video Resolution</label>
                  <div class="provider-buttons">
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '480p'"
                      (click)="videoResolution.set('480p')">
                      <span class="provider-name">480p</span>
                      <span class="provider-status">854 x 480</span>
                    </button>
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '720p'"
                      (click)="videoResolution.set('720p')">
                      <span class="provider-name">720p</span>
                      <span class="provider-status">1280 x 720</span>
                    </button>
                    <button class="provider-btn"
                      [class.selected]="videoResolution() === '1080p'"
                      (click)="videoResolution.set('1080p')">
                      <span class="provider-name">1080p</span>
                      <span class="provider-status">1920 x 1080</span>
                    </button>
                  </div>
                </div>
              }

              @if (!assemblyBlockedReason() && pipelineMode() === 'bilingual' && (!assemblySourceLang() || !assemblyTargetLang())) {
                <div class="warning-banner">
                  Select both source and target languages for assembly, or skip this step.
                </div>
              }
            </div>
          }

          <!-- ─────────────────────────────────────────────────────────────── -->
          <!-- Step 5: Review -->
          <!-- ─────────────────────────────────────────────────────────────── -->
          @case ('review') {
            <div class="step-panel">
              <h3>Review & Submit</h3>
              <p class="step-desc">Review your pipeline configuration before adding to queue.</p>

              <div class="review-cards">
                <!-- Passes card (standard run). The sentence-aligned pipeline keeps
                     its own cleanup/translation cards below. -->
                @if (pipelineMode() === 'mono') {
                  @if (passes().length > 0) {
                    <div class="review-card">
                      <div class="review-card-header">
                        <span class="review-card-icon">🧩</span>
                        <span class="review-card-title">Passes</span>
                        <span class="job-count">{{ passes().length }} job{{ passes().length > 1 ? 's' : '' }}</span>
                      </div>
                      <div class="review-card-content">
                        <div class="review-row">
                          <span class="review-label">Book:</span>
                          <span class="review-value">{{ selectedVariantLabel() }}</span>
                        </div>
                        @for (pass of passes(); track pass.uid; let i = $index) {
                          <div class="review-row">
                            <span class="review-label">{{ i + 1 }}.</span>
                            <span class="review-value">{{ passLabel(pass) }}{{ passDetail(pass) ? ' — ' + passDetail(pass) : '' }}</span>
                          </div>
                        }
                      </div>
                    </div>
                  } @else {
                    <div class="review-card skipped">
                      <div class="review-card-header">
                        <span class="review-card-icon">🧩</span>
                        <span class="review-card-title">Passes</span>
                        <span class="skipped-badge">None</span>
                      </div>
                    </div>
                  }
                }

                <!-- Cleanup Card (sentence-aligned only) -->
                @if (pipelineMode() === 'bilingual' && !isStepSkipped('cleanup') && (enableAiCleanup() || simplifyForLearning())) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔧</span>
                      <span class="review-card-title">AI Cleanup</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">{{ cleanupSourceEpub() === 'latest' ? 'Latest' : getFilenameFromPath(cleanupSourceEpub()) }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Provider:</span>
                        <span class="review-value">{{ cleanupProvider() }} / {{ cleanupModel() }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Mode:</span>
                        <span class="review-value">
                          {{ enableAiCleanup() && simplifyForLearning() ? 'AI Cleanup + Simplify' : enableAiCleanup() ? 'AI Cleanup' : simplifyForLearning() ? 'Simplify for Learning' : 'None' }}
                        </span>
                      </div>
                    </div>
                  </div>
                } @else if (pipelineMode() === 'bilingual') {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔧</span>
                      <span class="review-card-title">AI Cleanup</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- Translation Card (sentence-aligned only) -->
                @if (pipelineMode() === 'bilingual' && !isStepSkipped('translate') && targetLangs().size > 0) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🌐</span>
                      <span class="review-card-title">Translation</span>
                      <span class="job-count">{{ targetLangs().size }} job{{ targetLangs().size > 1 ? 's' : '' }}</span>
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Source:</span>
                        <span class="review-value">{{ translateSourceEpub() === 'latest' ? 'Latest' : getFilenameFromPath(translateSourceEpub()) }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Languages:</span>
                        <span class="review-value">{{ Array.from(targetLangs()).map(getLanguageName.bind(this)).join(', ') }}</span>
                      </div>
                      <div class="review-row">
                        <span class="review-label">Provider:</span>
                        <span class="review-value">{{ translateProvider() }} / {{ translateModel() }}</span>
                      </div>
                    </div>
                  </div>
                } @else if (pipelineMode() === 'bilingual') {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🌐</span>
                      <span class="review-card-title">Translation</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- TTS Card -->
                @if (!isStepSkipped('tts') && (pipelineMode() === 'mono' || ttsLanguageRows().length > 0)) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔊</span>
                      <span class="review-card-title">TTS</span>
                      @if (pipelineMode() === 'bilingual') {
                        <span class="job-count">{{ ttsLanguageRows().length }} job{{ ttsLanguageRows().length > 1 ? 's' : '' }}</span>
                      }
                    </div>
                    <div class="review-card-content">
                      <div class="review-row">
                        <span class="review-label">Engine:</span>
                        <span class="review-value">{{ ttsEngine().toUpperCase() }} / {{ reviewDeviceLabel() }}</span>
                      </div>
                      @if (pipelineMode() === 'mono') {
                        <div class="review-row">
                          <span class="review-label">{{ monoTtsLanguage().toUpperCase() }}:</span>
                          <span class="review-value">{{ monoTtsVoice() }} @ {{ monoTtsSpeed() }}x</span>
                        </div>
                      } @else {
                        @for (row of ttsLanguageRows(); track row.id) {
                          <div class="review-row">
                            <span class="review-label">{{ row.language.toUpperCase() }}:</span>
                            <span class="review-value">{{ row.voice }} @ {{ row.speed }}x</span>
                          </div>
                        }
                      }
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🔊</span>
                      <span class="review-card-title">TTS</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }

                <!-- Assembly Card -->
                @if (!isStepSkipped('assembly') && !assemblyBlockedReason() && (pipelineMode() === 'mono' || (assemblySourceLang() && assemblyTargetLang()))) {
                  <div class="review-card">
                    <div class="review-card-header">
                      <span class="review-card-icon">🎵</span>
                      <span class="review-card-title">Assembly</span>
                    </div>
                    <div class="review-card-content">
                      @if (pipelineMode() === 'mono') {
                        <div class="review-row">
                          <span class="review-label">Output:</span>
                          <span class="review-value">M4B + VTT{{ generateVideo() ? ' + Video (' + videoResolution() + ')' : '' }}</span>
                        </div>
                        <div class="review-row">
                          <span class="review-label">Mode:</span>
                          <span class="review-value">{{ ttsInThisRun() ? 'Chained after TTS' : 'From cached session' }}</span>
                        </div>
                      } @else {
                        <div class="review-row">
                          <span class="review-label">Pair:</span>
                          <span class="review-value">{{ assemblySourceLang().toUpperCase() }} + {{ assemblyTargetLang().toUpperCase() }}</span>
                        </div>
                        <div class="review-row">
                          <span class="review-label">Pattern:</span>
                          <span class="review-value">{{ assemblyPattern() }}</span>
                        </div>
                        <div class="review-row">
                          <span class="review-label">Timing:</span>
                          <span class="review-value">{{ pauseDuration() }}s pause, {{ gapDuration() }}s gap</span>
                        </div>
                      }
                    </div>
                  </div>
                } @else {
                  <div class="review-card skipped">
                    <div class="review-card-header">
                      <span class="review-card-icon">🎵</span>
                      <span class="review-card-title">Assembly</span>
                      <span class="skipped-badge">Skipped</span>
                    </div>
                  </div>
                }
              </div>

              <!-- Job Count Summary -->
              <div class="job-summary">
                <span class="job-summary-label">Total jobs to create:</span>
                <span class="job-summary-value">{{ getTotalJobCount() }}</span>
              </div>

              <!-- Warnings -->
              @if (getReviewWarnings().length > 0) {
                <div class="review-warnings">
                  @for (warning of getReviewWarnings(); track warning) {
                    <div class="warning-item">⚠️ {{ warning }}</div>
                  }
                </div>
              }

              @if (getTotalJobCount() === 0) {
                <div class="warning-banner">
                  No jobs to create. Go back and configure at least one step.
                </div>
              }
            </div>
          }
        }
      </div>

      <!-- Navigation -->
      <div class="wizard-nav">
        @if (continueMode() && currentStep() === 'tts') {
          <!-- Continue mode is pinned to TTS→Assembly→Review; the pass builder is
               disabled, so there's nowhere to go Back to from here. -->
          <span></span>
        } @else if (currentStep() !== 'passes') {
          <button class="btn-back" (click)="goBack()">
            ← Back
          </button>
        } @else {
          <button class="btn-back" (click)="back.emit()">
            ← Back
          </button>
        }

        <div class="nav-right">
          @if (currentStep() !== 'review') {
            <button class="btn-skip" (click)="skipStep()">
              Skip
            </button>
            <button class="btn-next" (click)="goNext()" [disabled]="!canProceed()">
              Next →
            </button>
          } @else {
            <button
              class="btn-queue"
              [class.added]="addedToQueue()"
              [disabled]="getTotalJobCount() === 0 || addingToQueue() || addedToQueue()"
              (click)="addToQueue()"
            >
              @if (addingToQueue()) {
                Adding...
              } @else if (addedToQueue()) {
                ✓ Added to Queue
              } @else {
                Add to Queue ({{ getTotalJobCount() }} jobs)
              }
            </button>
            @if (voiceDownloadMsg(); as msg) {
              <span class="voice-download-msg">{{ msg }}</span>
            }
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
    }

    .wizard {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 16px;
      overflow: hidden;
    }

    /* Step Indicator */
    .step-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .step {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 20px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      opacity: 0.6;
      transition: all 0.2s ease;

      &.active {
        opacity: 1;
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .step-num {
          background: #06b6d4;
          color: white;
        }
      }

      &.completed {
        opacity: 1;

        .step-num {
          background: #22c55e;
          color: white;
        }
      }

      &.skipped {
        opacity: 0.5;

        .step-num {
          background: var(--text-muted);
          color: white;
        }

        .step-label {
          text-decoration: line-through;
        }
      }

      &.has-data:not(.active):not(.completed) {
        opacity: 0.85;
        border-color: rgba(34, 197, 94, 0.4);
      }
    }

    .data-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
    }

    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--bg-base);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .step-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .step-connector {
      width: 16px;
      height: 2px;
      background: var(--border-default);
    }

    /* Step Content */
    .step-content {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
    }

    .step-panel {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 24px;
      position: relative;

      &.scrollable {
        max-height: 100%;
        overflow-y: auto;
      }

    .ai-layover {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
      backdrop-filter: blur(2px);
    }

    .ai-layover-card {
      max-width: 420px;
      text-align: center;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 10px;
      padding: 28px 32px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .ai-layover-icon { font-size: 2.5rem; margin-bottom: 8px; }
    .ai-layover-card h4 { margin: 0 0 8px; font-size: 1.1rem; color: var(--text-primary); }
    .ai-layover-card p { margin: 0 0 18px; font-size: 0.875rem; color: var(--text-secondary); line-height: 1.5; }
    .ai-layover-btn {
      padding: 9px 20px;
      border: none;
      border-radius: 6px;
      background: var(--accent-primary);
      color: #fff;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .ai-layover-btn:hover { opacity: 0.9; }

    .lang-gate {
      margin: 12px 0 4px;
      padding: 14px 16px;
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-default));
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 7%, transparent);
    }
    .lang-gate-head {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .lang-gate-icon { font-size: 1.4rem; line-height: 1.2; }
    .lang-gate-head h4 { margin: 0 0 2px; font-size: 0.95rem; color: var(--text-primary); }
    .lang-gate-head p { margin: 0; font-size: 0.8rem; color: var(--text-secondary); line-height: 1.45; }
    .lang-gate-list { display: flex; flex-direction: column; gap: 6px; }
    .lang-gate-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--bg-elevated);
    }
    .lang-gate-name { flex: 0 0 auto; min-width: 120px; font-size: 0.85rem; color: var(--text-primary); }
    .lang-gate-progress {
      flex: 1 1 auto;
      height: 6px;
      border-radius: 3px;
      background: var(--bg-hover);
      overflow: hidden;
    }
    .lang-gate-bar { height: 100%; background: var(--accent); transition: width 0.2s ease; }
    .lang-gate-btn {
      margin-left: auto;
      padding: 5px 14px;
      border: none;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
    }
    .lang-gate-btn:hover { opacity: 0.9; }
    .lang-gate-btn:disabled { opacity: 0.5; cursor: default; }
    .lang-gate-btn.ghost {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-default);
    }
    .lang-gate-link {
      margin-top: 10px;
      padding: 0;
      border: none;
      background: none;
      color: var(--accent);
      font-size: 0.8rem;
      cursor: pointer;
    }
    .lang-gate-link:hover { text-decoration: underline; }

      h3 {
        margin: 0 0 8px;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .step-desc {
        margin: 0 0 24px;
        font-size: 14px;
        color: var(--text-secondary);
      }
    }

    /* Config Sections */
    .config-section {
      margin-top: 16px;
    }

    .device-hint {
      margin: 8px 0 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--text-secondary);
    }
    .device-warning {
      margin: 8px 0 0;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--text-primary);
      background: color-mix(in srgb, #ef4444 14%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 45%, transparent);
      border-radius: 6px;
    }
    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 8px;

      &:first-child {
        margin-top: 0;
      }
    }

    .provider-buttons {
      display: flex;
      gap: 8px;
    }

    .provider-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      color: var(--text-primary);

      .provider-icon {
        font-size: 1.5rem;
      }

      .provider-name {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .provider-status {
        font-size: 10px;
        color: var(--text-muted);

        &.connected {
          color: #22c55e;
        }
      }

      &:hover:not(.disabled) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .provider-name {
          color: #06b6d4;
        }
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .select-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;

      &:focus {
        outline: none;
        border-color: #06b6d4;
      }

      option {
        background: var(--bg-surface);
      }
    }

    .configure-ai-btn {
      margin-top: 10px;
      padding: 7px 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
    }
    .configure-ai-btn:hover { border-color: var(--accent-primary); }

    .no-models {
      padding: 12px;
      font-size: 13px;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border-radius: 6px;
      line-height: 1.5;

      .error-text {
        color: #ef4444;
      }

      a {
        color: #06b6d4;
      }

      code {
        background: var(--bg-elevated);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
      }
    }

    /* Processing Options */
    .processing-options {
      margin-top: 16px;
    }

    .toggle-section-inline {
      display: flex;
      gap: 12px;

      .option-toggle {
        flex: 1;
      }
    }

    .toggle-section {
      margin-top: 16px;
    }

    .option-toggle {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 16px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;

      .toggle-icon {
        font-size: 24px;
      }

      .toggle-label {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-secondary);
      }

      .toggle-sublabel {
        font-size: 11px;
        color: var(--text-muted);
      }

      &:hover:not(.active) {
        border-color: var(--border-default);
        background: var(--bg-hover);
      }

      &.active {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 10%, var(--bg-elevated));

        .toggle-label {
          color: #06b6d4;
        }

        .toggle-sublabel {
          color: #06b6d4;
          opacity: 0.8;
        }
      }
    }

    .ocr-repair-note {
      margin-top: 12px;
      padding: 8px 12px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-muted);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }

    .stage-origin {
      margin-left: 8px;
      font-size: 10px;
      font-weight: 400;
      color: var(--text-tertiary);
      white-space: nowrap;
    }

    .simplify-mode-selector {
      margin-top: 12px;

      .mode-options {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
      }

      .mode-option {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        padding: 10px 12px;
        text-align: left;
        background: var(--bg-elevated);
        border: 2px solid var(--border-subtle);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s;

        .mode-label {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-secondary);
        }

        .mode-desc {
          font-size: 11px;
          color: var(--text-muted);
        }

        &:hover:not(.active) {
          border-color: var(--border-default);
          background: var(--bg-hover);
        }

        &.active {
          border-color: #06b6d4;
          background: color-mix(in srgb, #06b6d4 10%, var(--bg-elevated));

          .mode-label {
            color: #06b6d4;
          }
        }
      }
    }

    .existing-cleanup-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--info, var(--accent)) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--info, var(--accent)) 40%, transparent);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);

      .start-over-btn {
        flex-shrink: 0;
        padding: 4px 12px;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        background: transparent;
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;

        &:hover {
          background: color-mix(in srgb, var(--text-primary) 8%, transparent);
        }
      }
    }

    .warning-banner {
      display: block;
      width: 100%;
      margin-top: 12px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid var(--warning);
      border-radius: 6px;
      font-size: 12px;
      color: var(--warning);
      text-align: center;
    }

    .accordion {
      margin-top: 16px;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }

    .accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .accordion-content {
      padding: 12px;
      border-top: 1px solid var(--border-subtle);
    }

    .prompt-textarea {
      width: 100%;
      min-height: 220px;
      padding: 10px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: monospace;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
      box-sizing: border-box;
    }

    .prompt-footer {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }

    .btn-save-prompt {
      padding: 6px 14px;
      background: var(--accent-primary);
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 12px;
      cursor: pointer;

      &:disabled {
        opacity: 0.6;
        cursor: default;
      }
    }

    .test-mode-config {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      padding: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      label {
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
      }
    }

    .chunk-options {
      display: flex;
      gap: 6px;
    }

    .chunk-option {
      padding: 6px 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: #06b6d4;
        background: color-mix(in srgb, #06b6d4 15%, var(--bg-subtle));
        color: #06b6d4;
      }
    }

    /* Language Grid */
    .source-lang-display {
      padding: 12px 16px;
      background: var(--bg-elevated);
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        font-weight: 500;
        margin-left: 8px;
      }
    }

    .language-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .language-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 12px 8px;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;

      .lang-flag {
        display: block;
        width: 32px;
        height: 20px;
        border-radius: 3px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        flex-shrink: 0;
      }

      .lang-code {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .lang-name {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .lang-check {
        position: absolute;
        top: 4px;
        right: 4px;
        font-size: 12px;
        color: #06b6d4;
        font-weight: bold;
      }

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;

        .lang-name {
          color: #06b6d4;
        }
      }
    }

    .selection-summary {
      margin-top: 12px;
      padding: 8px 12px;
      background: rgba(6, 182, 212, 0.1);
      border: 1px solid rgba(6, 182, 212, 0.3);
      border-radius: 6px;
      font-size: 12px;
      color: #06b6d4;
    }

    .existing-translations {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .existing-translation-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      font-size: 13px;
    }

    .existing-translation-label {
      color: var(--text-secondary);
    }

    .existing-translation-delete {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #ef4444;
      padding: 2px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: rgba(239, 68, 68, 0.15);
        border-color: #ef4444;
      }
    }

    .existing-translation-clear-all {
      align-self: flex-end;
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: rgba(239, 68, 68, 0.7);
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 4px;
      transition: all 0.15s;

      &:hover {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
        border-color: #ef4444;
      }
    }

    .hint {
      display: block;
      margin-top: 8px;
      font-size: 11px;
      color: var(--text-tertiary);
    }

    .download-more-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 12px;
      color: var(--accent);
      cursor: pointer;
      &:hover { text-decoration: underline; }
    }

    /* Pipeline preset picker */
    .preset-section {
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .preset-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .preset-select { flex: 1; min-width: 0; }
    .preset-delete {
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: all 0.15s ease;
      &:hover { color: var(--error); border-color: var(--error); }
    }
    .preset-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .reset-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .reset-stock-btn {
      flex-shrink: 0;
      padding: 4px 10px;
      font-size: 12px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-secondary);
      cursor: pointer;
      &:hover { background: var(--bg-elevated); color: var(--text-primary); }
    }

    .custom-instructions {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
      min-height: 60px;

      &:focus {
        outline: none;
        border-color: var(--accent-primary);
      }

      &::placeholder {
        color: var(--text-muted);
      }
    }

    /* Worker Options */
    .worker-options {
      display: flex;
      gap: 8px;
    }

    .worker-btn {
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;
        color: #06b6d4;
      }
    }

    .full-width-slider {
      width: 100%;
      margin-top: 4px;
    }

    /* Source Stage Buttons */
    .source-stages {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .stage-btn {
      padding: 6px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 4px;

      .stage-check {
        color: #22c55e;
        font-size: 11px;
      }

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.15);
        border-color: #06b6d4;
        color: #06b6d4;

        .stage-check {
          color: #06b6d4;
        }
      }

      &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    }

    /* Language Rows (TTS) */
    .language-rows {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .language-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      .lang-select {
        width: 140px;
        padding: 6px 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-primary);
      }

      .epub-auto {
        width: 140px;
        padding: 6px 8px;
        background: var(--bg-subtle);
        border: 1px solid var(--border-subtle);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-secondary);
        display: inline-block;
        text-align: center;
        font-style: italic;
      }

      .voice-select {
        flex: 1;
        min-width: 120px;
        padding: 6px 8px;
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-primary);
      }

      .speed-slider {
        width: 80px;
      }

      .speed-label {
        width: 40px;
        font-size: 12px;
        color: var(--text-secondary);
        text-align: right;
      }

      .remove-row-btn {
        padding: 4px 8px;
        background: transparent;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        font-size: 12px;
        color: var(--text-muted);
        cursor: pointer;
        transition: all 0.15s;

        &:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.15);
          border-color: #ef4444;
          color: #ef4444;
        }

        &:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
      }
    }

    .add-row-btn {
      margin-top: 8px;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border: 1px dashed var(--border-default);
      border-radius: 6px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
        border-color: #06b6d4;
        color: #06b6d4;
      }
    }

    /* Review Cards */
    .review-cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .review-card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;

      &.skipped {
        opacity: 0.5;

        .review-card-header {
          background: var(--bg-subtle);
        }
      }
    }

    .review-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(6, 182, 212, 0.1);
      border-bottom: 1px solid var(--border-subtle);

      .review-card-icon {
        font-size: 16px;
      }

      .review-card-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
      }

      .job-count {
        font-size: 11px;
        padding: 2px 8px;
        background: #06b6d4;
        color: white;
        border-radius: 10px;
      }

      .skipped-badge {
        font-size: 11px;
        padding: 2px 8px;
        background: var(--text-muted);
        color: white;
        border-radius: 10px;
      }
    }

    .review-card-content {
      padding: 12px;
    }

    .review-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      font-size: 12px;

      .review-label {
        color: var(--text-secondary);
      }

      .review-value {
        color: var(--text-primary);
        font-weight: 500;
      }
    }

    .job-summary {
      margin-top: 16px;
      padding: 16px;
      background: var(--bg-elevated);
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;

      .job-summary-label {
        font-size: 14px;
        color: var(--text-secondary);
      }

      .job-summary-value {
        font-size: 24px;
        font-weight: 700;
        color: #06b6d4;
      }
    }

    .review-warnings {
      margin-top: 12px;
      padding: 12px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      border: 1px solid var(--warning);
      border-radius: 6px;

      .warning-item {
        font-size: 12px;
        color: var(--warning);
        padding: 4px 0;
      }
    }

    /* Navigation */
    .wizard-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 16px;
      border-top: 1px solid var(--border-subtle);
      margin-top: 16px;
    }

    .nav-right {
      display: flex;
      gap: 8px;
    }

    .btn-back,
    .btn-skip,
    .btn-next,
    /* ── Pass builder ──────────────────────────────────────────────────── */

    .variant-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 8px;
    }

    .variant-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      padding: 10px 12px;
      text-align: left;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      .variant-format {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }

      .variant-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .variant-file {
        font-size: 11px;
        color: var(--text-muted);
        word-break: break-all;
      }

      .variant-note {
        font-size: 11px;
        color: var(--text-muted);
        font-style: italic;
      }

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.selected {
        border-color: #06b6d4;
        background: rgba(6, 182, 212, 0.15);

        .variant-title { color: #06b6d4; }
      }

      &:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    }

    .pass-builder {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(240px, 320px);
      gap: 16px;
      align-items: start;
      margin-top: 8px;
    }

    .pass-palette {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .palette-btn {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 10px 12px;
      text-align: left;
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      .palette-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .palette-desc {
        font-size: 11px;
        color: var(--text-muted);
      }

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--border-default);
      }

      &.open {
        border-color: #06b6d4;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .palette-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }

    .palette-add-btn {
      align-self: flex-start;
      padding: 8px 14px;
      background: #06b6d4;
      border: none;
      border-radius: 6px;
      color: white;
      font-size: 12px;
      cursor: pointer;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .lang-pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .lang-pair-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .pass-sidebar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      position: sticky;
      top: 0;
    }

    .pass-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;

      &.invalid {
        border-color: #ef4444;
      }
    }

    .pass-card-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pass-index {
      font-size: 11px;
      color: var(--text-muted);
      min-width: 14px;
    }

    .pass-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .pass-detail {
      font-size: 11px;
      color: var(--text-muted);
      padding-left: 20px;
    }

    .pass-btn {
      background: transparent;
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1;
      padding: 4px 6px;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.remove:hover:not(:disabled) {
        color: #ef4444;
        border-color: #ef4444;
      }

      &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
    }

    .pass-error {
      font-size: 11px;
      line-height: 1.4;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 6px;
      padding: 8px 10px;
    }

    /* A step with nothing to work on: one sentence, no controls. */
    .step-blocked {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-muted);
      background: var(--bg-surface);
      border: 1px dashed var(--border-subtle);
      border-radius: 8px;
      padding: 16px;
    }

    .btn-queue {
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .voice-download-msg {
      margin-left: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .btn-back {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-skip {
      background: transparent;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-next {
      background: #06b6d4;
      border: none;
      color: white;

      &:hover:not(:disabled) {
        background: #0891b2;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-queue {
      background: var(--accent);
      border: none;
      color: var(--bg-primary);

      &:hover:not(:disabled) {
        background: #16a34a;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.added {
        background: var(--accent);
        opacity: 0.8;
      }
    }
  `]
})
export class LLWizardComponent implements OnInit {
  private readonly settingsService = inject(SettingsService);
  private readonly electronService = inject(ElectronService);
  private readonly dialog = inject(DialogService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);
  private readonly epubResolver = inject(EpubResolverService);
  // Public for the template: gates optional TTS engines (e.g. Orpheus) on
  // availability, AND lists installed RVC enhancement voices (kind 'rvc-model').
  protected readonly componentService = inject(ComponentService);
  // Gates the AI Cleanup step behind a "set up an AI" layover when none configured.
  protected readonly ai = inject(AiService);
  protected readonly langPacks = inject(LanguagePackService);
  protected readonly workerCfg = inject(WorkerConfigService);

  /**
   * Languages the TTS step needs a Stanza segmentation pack for, that aren't
   * installed yet. TTS narrates per language and segments text with Stanza;
   * translation itself is the AI's job and needs no pack, so this gate lives on
   * the TTS step (whole-book: the narration language; sentence: each row's
   * language). Installed packs (bundled OR downloaded) are skipped, so an
   * already-present pack is never re-prompted.
   */
  readonly missingTtsLanguagePacks = computed(() => {
    if (!this.langPacks.checkedOnce()) return [];
    const needed = new Set<string>();
    if (this.translateMode() === 'sentence') {
      for (const row of this.ttsLanguageRows()) {
        if (row.language) needed.add(row.language);
      }
    } else {
      const lang = this.monoTtsLanguage();
      if (lang) needed.add(lang);
    }
    const out: { code: string; name: string; installing: boolean; pct: number }[] = [];
    for (const code of needed) {
      const st = this.langPacks.statusFor(code);
      if (!st || st.state === 'installed') continue; // not offered, or already present
      out.push({
        code,
        name: this.getLanguageName(code),
        installing: st.state === 'installing',
        pct: st.progress?.pct ?? 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });

  // Make Array available in template
  readonly Array = Array;

  // ─────────────────────────────────────────────────────────────────────────
  // Inputs/Outputs
  // ─────────────────────────────────────────────────────────────────────────

  // Primary inputs (compatible with bilingual-wizard for Studio integration)
  readonly epubPath = input<string>('');
  readonly originalEpubPath = input<string>('');
  readonly title = input<string>('');
  readonly author = input<string>('');
  readonly year = input<string>('');
  readonly itemType = input<'book' | 'article'>('book');
  readonly projectId = input<string>('');
  readonly projectDir = input<string>('');
  readonly audiobookFolder = input<string>('');
  readonly coverPath = input<string>('');  // Absolute path to cover image
  /**
   * What this project was IMPORTED from (manifest.source.type) — NOT the source EPUB
   * the user picks above, which is always a derivative (exported.epub). Only the
   * import provenance says whether the words came off a scanner, so it is what the
   * OCR-repair default keys on. '' means the caller had no project selected.
   */
  readonly sourceType = input<SourceType | ''>('');

  // Language Learning specific inputs
  readonly projectTitle = input<string>('');
  readonly initialSourceLang = input<string>('en');
  readonly refreshTrigger = input<number>(0);  // bump to re-scan stages after a delete/reset
  readonly continueRequest = input<number>(0);  // bump to enter Continue mode (land on TTS, pre-fill last run's settings)
  /**
   * Bump to stand on the TTS step — the narration hand-off.
   *
   * Two doors arrive here (docs/PIPELINE_V2_PLAN.md, Phase C): the picker's Next
   * at the top of its ladder, and the Process button on a document row. Both
   * mean "narrate this book", and narration is this wizard's TTS step.
   *
   * NOT `continueRequest`, which is a different request that only looks similar:
   * Continue resumes an INTERRUPTED render — it refuses outright when there is
   * no partial session, and it disables the earlier steps because there is
   * nothing to re-run. A book arriving from the picker has no partial session
   * and is not resuming anything.
   *
   * A counter rather than a flag, exactly like `continueRequest`, so asking a
   * second time for the same book is a second event and not a no-op.
   */
  readonly narrationRequest = input<number>(0);

  // Mono-pipeline inputs (whole-book mode)
  readonly contributors = input<Array<{ first: string; last: string }> | undefined>(undefined);
  readonly cachedSession = input<any>(null);       // Cached TTS session for standalone reassembly
  readonly outputFilename = input<string>('');     // Saved manifest filename — respected over derived name

  readonly queued = output<void>();
  readonly back = output<void>();

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation State
  // ─────────────────────────────────────────────────────────────────────────

  readonly currentStep = signal<LLWizardStep>('passes');
  private completedSteps = new Set<LLWizardStep>();
  private _skippedSteps = new Set<LLWizardStep>();

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1 (standard run): the pass builder
  //
  // A run is an ordered list of passes over ONE of the project's files. Which
  // orders are legal is MAIN's answer, not this component's: every edit re-plans
  // through `processing:plan-chain`, which runs exactly the validation
  // `processing:submit-chain` runs, so what the sidebar refuses and what the
  // submission refuses can never drift apart.
  // ─────────────────────────────────────────────────────────────────────────

  readonly variantCards = signal<PassVariantCard[]>([]);
  readonly loadingVariants = signal(false);
  /** '' is a real value: the project's book EPUB, which is not a variant. */
  readonly selectedVariantId = signal<string>('');
  readonly passes = signal<BuilderPass[]>([]);
  /** Which palette entry has its configuration open, if any. */
  readonly palettePanel = signal<ProcessingPassKind | null>(null);
  readonly planning = signal(false);
  readonly chainPlan = signal<ProcessingChainPlan | null>(null);
  readonly chainError = signal<string | null>(null);
  /** The languages the NEXT translate pass will carry (the palette's draft). */
  readonly passTranslateSource = signal<string>('en');
  readonly passTranslateTarget = signal<string>('en');
  /**
   * The NEXT footnote pass's one option (the palette's draft), OFF by default.
   *
   * foundry skips note bodies and index entries because in the measured books
   * those units are pure false-fire risk — a note's leading number is its own
   * label, an index entry's trailing numbers are page references, and neither is
   * a marker anyone reads aloud. Turning the skips off is a judgement about a
   * particular book, so it is a per-pass choice and never the default.
   */
  readonly passFootnotesAskEverything = signal(false);
  /** The project's book EPUB (manifest `outputs.epub`) when it is on disk. */
  readonly bookEpubPath = signal<string | null>(null);
  /** Which EPUB the standard TTS job reads. See ttsInputPath. */
  readonly ttsInput = signal<'book' | 'run'>('book');
  private passUid = 0;
  private planTimer: ReturnType<typeof setTimeout> | null = null;

  readonly selectedVariant = computed<PassVariantCard | null>(() =>
    this.variantCards().find(c => c.id === this.selectedVariantId()) ?? null);

  readonly selectedVariantLabel = computed(() => {
    const card = this.selectedVariant();
    return card ? `${card.label} (${card.format.toUpperCase()})` : 'the project book';
  });

  /** Foundry passes read a PDF; nothing else can stand in for one. */
  readonly selectedIsPdf = computed(() =>
    (this.selectedVariant()?.format ?? '').toLowerCase() === 'pdf');

  /**
   * Whether the selected PDF carries text of its own, measured in main.
   *
   * Keyed by the path it was measured for, because the variant cards change
   * under this: an answer about the previous PDF must never be read as an answer
   * about this one.
   */
  readonly textLayer = signal<{ path: string; report: TextLayerReport } | null>(null);
  readonly textLayerError = signal<string | null>(null);
  readonly measuringTextLayer = signal(false);

  /**
   * The OCR unit cannot be removed: this PDF has no text, so without it the run
   * produces a book with no words in it.
   *
   * Null when it is optional, or when we do not KNOW yet — a check that has not
   * finished, or one that failed, never reads as "optional". The failure is shown
   * separately (textLayerError) rather than guessed at.
   */
  readonly ocrRequiredReason = computed<string | null>(() => {
    if (!this.selectedIsPdf()) return null;
    const measured = this.textLayer();
    const variant = this.selectedVariant();
    if (!measured || !variant || !this.samePath(measured.path, variant.absPath)) return null;
    if (measured.report.hasTextLayer) return null;
    return 'This PDF is pictures of pages — it carries no text of its own, so nothing can be '
      + 'narrated unless this pass reads it.';
  });

  readonly passPalette = computed<PalettteEntry[]>(() => {
    const pdf = this.selectedIsPdf();
    const noPdf = 'Reads the scanned pages — pick the PDF version of this book.';
    return [
      {
        // The cast: the archive original in, a working PDF with the words in it
        // out. For a scan that is Tesseract over every page; for a PDF that
        // already carries text it is one pass over the publisher's own layer and
        // costs seconds. Either way the result opens in any reader with the text
        // selectable, which is the whole test of whether it worked.
        //
        // Repairing what Tesseract misread is NOT here. That happens inside Build
        // the book, on the blocks that survived curation — so the running heads
        // and footnotes somebody deleted cost no GPU at all, instead of half an
        // hour of it before anyone had looked at them.
        kind: 'get-text', label: PASS_LABELS['get-text'],
        desc: 'Read the pages into a working PDF you can open and search. Add Detect blocks after it.',
        enabled: pdf, why: noPdf,
      },
      {
        // The pass that makes a book possible: every block labelled body, chapter
        // opening, running head, footnote, caption — which is what decides what
        // gets narrated and where the chapters split. It writes the answer INTO
        // the working PDF as real annotations, so Acrobat shows the boxes.
        kind: 'blocks', label: PASS_LABELS['blocks'],
        desc: 'Label every block — body, chapter, running head, footnote — as annotations in the working PDF.',
        enabled: pdf, why: noPdf,
      },
      {
        // The one exporter. Drops what was deleted, repairs the OCR of what was
        // kept, reflows the lines into paragraphs and takes each chapter's title
        // from its own block.
        kind: 'reflow', label: PASS_LABELS['reflow'],
        desc: 'Build the book EPUB from the working PDF — dropping what you deleted and repairing the OCR of what you kept.',
        enabled: pdf, why: noPdf,
      },
      {
        // The one pass with two readings of a book. On a PDF it is a stage of the
        // scan chain; on an EPUB it edits the publisher's own markup, where the
        // markers are <sup> links a narrator reads out as numbers.
        kind: 'footnotes', label: PASS_LABELS['footnotes'],
        desc: pdf
          ? 'Remove the reference markers OCR welds into the prose.'
          : 'Remove the reference markers from the book: the small numbers a narrator reads aloud.',
        enabled: true, why: '',
      },
      {
        kind: 'simplify', label: PASS_LABELS['simplify'],
        desc: 'Rewrite the prose: de-jargon, de-stiffen, or for language learners.',
        enabled: true, why: '',
      },
      {
        kind: 'translate', label: PASS_LABELS['translate'],
        desc: 'Translate the whole book into another language.',
        enabled: true, why: '',
      },
    ];
  });

  /** This run rebuilds or rewrites the book, so there will be an EPUB to narrate. */
  readonly runProducesEpub = computed(() =>
    this.passes().length > 0 && !!this.chainPlan() && !this.chainError());

  /**
   * The EPUB the standard TTS job reads: what the passes leave behind when there
   * are any (they rewrite the book in place, so it is the same path either way),
   * else the book as it stands.
   */
  readonly ttsInputPath = computed<string>(() => {
    const plan = this.chainPlan();
    if (this.passes().length > 0 && plan && !this.chainError()) return plan.bookEpubPath;
    return this.bookEpubPath() ?? '';
  });

  /**
   * Why narration cannot be configured, or null. Nothing to read is a fact about
   * the project, not a setting — so the step says it once and collects nothing.
   */
  readonly ttsBlockedReason = computed<string | null>(() => {
    // Sentence-aligned rows resolve their own per-language EPUBs at run time.
    if (this.pipelineMode() === 'bilingual') return null;
    if (this.runProducesEpub() || this.bookEpubPath()) return null;
    return 'This book has no EPUB to narrate, and no pass in this run produces one. '
      + 'Add an OCR-correction pass over the PDF on the first page, or export the book from the editor.';
  });

  /** Where the planner's refusal belongs: the row it names, or -1 for the run. */
  readonly chainErrorAt = computed<number>(() => {
    const message = this.chainError();
    if (!message) return -1;
    return this.passes().findIndex(p => message.startsWith(PASS_LABELS[p.kind]));
  });

  /** Every language, for the translate pass's from/into pickers. */
  readonly languageOptions = computed<DesktopSelectItems>(() =>
    this.supportedLanguages.map(l => ({ value: l.code, label: l.name })));

  // Continue mode: the user is resuming an interrupted TTS render. Cleanup + Translate
  // are disabled (nothing to re-run), the wizard is pinned to TTS→Assembly→Review, and
  // the TTS controls are pre-filled with the settings the original run used — all still
  // editable. Distinct from `continueTts` (the New/Continue toggle) so the settings
  // controls stay visible while continuing.
  readonly continueMode = signal(false);
  private continueRequestHandled = 0;
  /** The last `narrationRequest` acted on, so one bump moves the user once. */
  private narrationRequestHandled = 0;
  /** Show the editable TTS setting controls in both New and Continue modes. */
  readonly showTtsSettings = computed(() => !this.continueTts() || this.continueMode());

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  readonly cleanupSourceEpub = signal<string>('latest');
  readonly cleanupProvider = signal<AIProvider>('ollama');
  readonly cleanupModel = signal<string>('');
  readonly enableAiCleanup = signal(false);  // Start with neither selected
  readonly simplifyForLearning = signal(false);
  /**
   * Which cleanup passes to run. The two are independent products:
   *   'ocr'  — repair scanner damage, stop. Produces repaired.epub: faithful text
   *            with every footnote marker and curly quote still in place.
   *   'tts'  — narration prep only (footnote markers, quotes, numbers). Produces
   *            cleaned.epub; the only model in it is the small footnote-marker
   *            one, asked once per paragraph — not a per-chunk rewrite.
   *   'both' — repair, then prep.
   *
   * Defaulted from the project's import provenance in `syncCleanupStagesDefault`
   * and left alone once the user picks — a book scanned from a PDF needs the repair,
   * a born-digital EPUB does not and would just burn hours of model time.
   */
  readonly cleanupStages = signal<CleanupStages>('tts');
  readonly cleanupStageOptions = [
    { value: 'ocr' as const, label: 'OCR repair only', desc: 'Fix scanner damage - merged words, misread letters, broken hyphenation. Slow (reads every chunk). Keeps footnote numbers and curly quotes.' },
    { value: 'tts' as const, label: 'TTS cleaning only', desc: 'Remove the footnote reference markers the book\u2019s own markup names, straighten quotes, spell out numbers. Minutes \u2014 deterministic, no model. Markers a book does not mark up are the foundry footnotes pass\u2019s job.' },
    { value: 'both' as const, label: 'Both', desc: 'Repair the scan first, then prepare it for narration. What a scanned book normally wants.' },
  ];
  /** Set once the user picks a stage; stops provenance from overriding them. */
  private cleanupStagesTouched = false;
  /** Project dir the stage default was last applied for — switching books re-decides. */
  private cleanupStagesDefaultedFor = '';
  /** Why the picker starts where it does — shown beside it so the default is never a mystery. */
  readonly ocrRepairOriginHint = computed(() => {
    switch (this.sourceType()) {
      case 'pdf': return 'imported from PDF';
      case 'epub': return 'imported from EPUB';
      case 'url': return 'imported from a web page';
      case 'audiobook': return 'imported from an audiobook';
      default: return 'source unknown';
    }
  });
  // Which simplify mode to apply when simplifyForLearning is on.
  readonly simplifyMode = signal<'dejargon' | 'destiffen' | 'learner'>('learner');
  readonly simplifyModeOptions = [
    { value: 'dejargon' as const, label: 'De-jargon', desc: 'Plain English for dense, over-complex academic writing' },
    { value: 'destiffen' as const, label: 'De-stiffen', desc: 'Natural English for stiff or machine-translated text' },
    { value: 'learner' as const, label: 'Learner', desc: 'Simpler words and grammar for B1-B2 English learners' },
  ];
  readonly customInstructions = signal('');

  // AI prompt editor (edits the global cleanup prompt file)
  readonly promptAccordionOpen = signal(false);
  readonly loadingPrompt = signal(false);
  readonly savingPrompt = signal(false);
  readonly promptText = signal('');
  readonly originalPromptText = signal('');
  readonly promptModified = computed(() => this.promptText() !== this.originalPromptText());

  readonly hasExistingCleanup = computed(() => {
    return this.availableEpubs().some(e => e.filename === 'cleaned.epub' || e.filename === 'simplified.epub');
  });

  /** Stages relevant for cleanup source: Original, Exported, AI Cleaned, AI Simplified */
  readonly cleanupSourceStages = computed<SourceStage[]>(() => {
    const epubs = this.availableEpubs();
    const find = (name: string) => epubs.find(e => e.filename === name);
    return [
      { id: 'original', label: 'Original', completed: !!find('original.epub'), path: find('original.epub')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported.epub'), path: find('exported.epub')?.path ?? '' },
      { id: 'repaired', label: 'OCR-Repaired', completed: !!find('repaired.epub'), path: find('repaired.epub')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned.epub'), path: find('cleaned.epub')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified.epub'), path: find('simplified.epub')?.path ?? '' },
    ];
  });

  /** Stages relevant for translate source: Original, Exported, AI Cleaned, AI Simplified */
  readonly translateSourceStages = computed<SourceStage[]>(() => {
    const epubs = this.availableEpubs();
    const find = (name: string) => epubs.find(e => e.filename === name);
    return [
      { id: 'original', label: 'Original', completed: !!find('original.epub'), path: find('original.epub')?.path ?? '' },
      { id: 'exported', label: 'Exported', completed: !!find('exported.epub'), path: find('exported.epub')?.path ?? '' },
      { id: 'cleaned', label: 'AI Cleaned', completed: !!find('cleaned.epub'), path: find('cleaned.epub')?.path ?? '' },
      { id: 'simplified', label: 'AI Simplified', completed: !!find('simplified.epub'), path: find('simplified.epub')?.path ?? '' },
    ];
  });

  /** Stage order tiebreak for mtime-based resolution (higher = preferred when mtimes are equal) */
  private static readonly STAGE_ORDER: Record<string, number> = {
    'original.epub': 0,
    'exported.epub': 1,
    'cleaned.epub': 2,
    'simplified.epub': 3,
    'translated.epub': 4,
  };

  /**
   * Pick the most recently modified EPUB from candidates.
   * Tiebreak by stage order (later stage wins).
   */
  private getMostRecentEpub(candidates: AvailableEpub[], exclude?: Set<string>): AvailableEpub | null {
    const filtered = candidates.filter(e => e.mtimeMs != null && (!exclude || !exclude.has(e.filename)));
    if (filtered.length === 0) return null;
    filtered.sort((a, b) => {
      const diff = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
      if (diff !== 0) return diff;
      return (LLWizardComponent.STAGE_ORDER[b.filename] ?? 0) - (LLWizardComponent.STAGE_ORDER[a.filename] ?? 0);
    });
    return filtered[0];
  }

  /** What the cleanup step will produce, if it's active in this pipeline run */
  private cleanupWillProduce(): 'cleaned.epub' | 'simplified.epub' | 'repaired.epub' | null {
    if (this._skippedSteps.has('cleanup')) return null;
    if (this.simplifyForLearning()) return 'simplified.epub';
    // An OCR-repair-only run stops at pass 1, so the next step must chain off
    // repaired.epub — cleaned.epub is never written.
    if (this.enableAiCleanup()) return this.cleanupStages() === 'ocr' ? 'repaired.epub' : 'cleaned.epub';
    return null;
  }

  /**
   * Resolve which stage ID "latest" maps to, for the sentence-aligned pipeline's
   * cleanup and translation inputs. Narration no longer picks a stage: a standard
   * run narrates the book (see ttsInputPath) and the bilingual rows resolve their
   * own per-language EPUBs.
   */
  private resolveLatestStageId(step: 'cleanup' | 'translate'): string {
    const epubs = this.availableEpubs();
    const has = (name: string) => epubs.some(e => e.filename === name);
    if (step === 'cleanup') {
      // Cleanup input: most recently modified source file (not cleaned/simplified — we produce those)
      const sourceOnly = new Set(['cleaned.epub', 'simplified.epub', 'translated.epub']);
      const best = this.getMostRecentEpub(epubs, sourceOnly);
      if (best) return best.filename.replace('.epub', '');
      if (has('exported.epub')) return 'exported';
      if (has('original.epub')) return 'original';
    } else {
      // Translate input: most recently modified wins (exclude translated — we produce that)
      // Also exclude per-language EPUBs (xx.epub) since those are translation outputs
      const exclude = new Set<string>();
      for (const e of epubs) {
        if (e.isTranslated || e.filename === 'translated.epub') exclude.add(e.filename);
      }
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.filename.replace('.epub', '');
      if (has('simplified.epub')) return 'simplified';
      if (has('cleaned.epub')) return 'cleaned';
      if (has('exported.epub')) return 'exported';
      if (has('original.epub')) return 'original';
    }
    return '';
  }

  private sourceSignalFor(step: 'cleanup' | 'translate') {
    return step === 'cleanup' ? this.cleanupSourceEpub : this.translateSourceEpub;
  }

  /** Check if a stage button should be highlighted as selected */
  isStageSelected(step: 'cleanup' | 'translate', stage: SourceStage): boolean {
    const source = this.sourceSignalFor(step)();
    if (source === 'latest') {
      return stage.id === this.resolveLatestStageId(step);
    }
    return source === stage.path;
  }

  /** Handle stage button click — clicking the auto-selected stage returns to 'latest' */
  selectStage(step: 'cleanup' | 'translate', stage: SourceStage): void {
    const signal = this.sourceSignalFor(step);
    const current = signal();

    // If clicking the currently selected stage, toggle back to 'latest'
    if (current === stage.path || (current === 'latest' && stage.id === this.resolveLatestStageId(step))) {
      signal.set('latest');
    } else {
      signal.set(stage.path);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sentence-aligned (language-learning) translation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * THE run-type switch, kept under its old name because it is what `pipelineMode`
   * — and therefore every job builder below — reads.
   * - null:       standard run. Translation, if any, is a PASS.
   * - 'sentence': bilingual / language-learning pipeline (sentence-aligned
   *   per-language translation, per-language TTS rows, interleaved assembly).
   */
  readonly translateMode = signal<'sentence' | null>(null);
  readonly pipelineMode = computed<'mono' | 'bilingual'>(() =>
    this.translateMode() === 'sentence' ? 'bilingual' : 'mono');

  readonly translateSourceEpub = signal<string>('latest');
  readonly targetLangs = signal<Set<string>>(new Set());
  readonly translateProvider = signal<AIProvider>('ollama');
  readonly translateModel = signal<string>('');
  readonly detectedSourceLang = signal<string>('en');
  readonly translateCustomInstructions = signal('');

  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  /** Translation EPUBs that already exist in the project (e.g., en.epub, de.epub) */
  readonly existingTranslationEpubs = computed(() => {
    return this.availableEpubs().filter(e => e.isTranslated);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: TTS
  // ─────────────────────────────────────────────────────────────────────────

  readonly ttsEngine = signal<TTSEngine>('xtts');
  /** All engines in display order; the template gates each by its install requirement. */
  protected readonly engineList: TtsEngineCaps[] = [
    TTS_ENGINES.xtts, TTS_ENGINES.f5, TTS_ENGINES.orpheus, TTS_ENGINES.voxtral,
  ];
  /** Capabilities of the currently-selected engine — drives which controls appear. */
  readonly currentCaps = computed(() => engineCaps(this.ttsEngine()));
  readonly ttsDevice = signal<'auto' | 'cpu' | 'mps' | 'gpu'>('auto');
  // Mac GPU acceleration is MPS (Metal); CUDA is Windows/Linux only — so the
  // device picker offers the right GPU per platform instead of a dead button.
  readonly isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
  readonly ttsWorkers = signal(2);
  /** Once the user picks a worker count here, stop re-syncing it from the global. */
  private workerCountTouched = false;
  /**
   * The device the job will ACTUALLY run on, resolving 'auto' the same way the
   * main process does: CUDA when the GPU pack is present, MPS on Apple Silicon,
   * else CPU. Explicit choices are honored exactly (CPU stays CPU even with the
   * pack installed). Drives the worker-count logic and the review label.
   */
  readonly resolvedTtsDevice = computed<'cpu' | 'mps' | 'gpu'>(() => {
    const d = this.ttsDevice();
    if (d === 'gpu' || d === 'mps' || d === 'cpu') return d;
    // auto → best available
    if (this.componentService.isInstalled('cuda-tts')) return 'gpu';
    if (this.isMac) return 'mps';
    return 'cpu';
  });
  /**
   * Will this TTS job actually run on the GPU? On a single GPU the engine
   * serializes to one worker — and extra MPS workers each load a model and spike
   * unified memory — so parallel workers are pointless: hide the control and
   * force 1 there. Explicit CPU is never GPU, even with the pack installed.
   */
  readonly ttsUsesGpu = computed(() => this.resolvedTtsDevice() !== 'cpu');
  /** Review-step device label — shows what the run actually uses, e.g.
   *  "AUTO (CUDA)" or just "CPU", so the summary never claims CPU while CUDA runs. */
  readonly reviewDeviceLabel = computed(() => {
    const resolved = { cpu: 'CPU', mps: 'GPU (MPS)', gpu: 'GPU (CUDA)' }[this.resolvedTtsDevice()];
    return this.ttsDevice() === 'auto' ? `AUTO (${resolved})` : resolved;
  });
  /** Inline hint under the device picker — surfaces what 'auto' resolves to and
   *  warns when an explicit GPU choice can't run without the pack. */
  readonly deviceHint = computed(() => {
    const d = this.ttsDevice();
    const gpuPack = this.componentService.isInstalled('cuda-tts');
    if (d === 'auto') {
      if (this.isMac) return 'Runs on your Mac’s GPU (Metal/MPS).';
      return gpuPack
        ? 'Runs on your NVIDIA GPU (CUDA) — fastest.'
        : 'Runs on CPU. Install “Faster Voice Narration” in Settings → Add-ons to use your GPU.';
    }
    if (d === 'cpu') return 'Always runs on CPU (slower, no GPU needed).';
    if (d === 'mps') return 'Runs on your Mac’s GPU (Metal/MPS).';
    return gpuPack
      ? 'Runs on your NVIDIA GPU (CUDA).'
      : '⚠ Needs the “Faster Voice Narration” GPU pack (Settings → Add-ons), or the conversion will fail.';
  });
  /** What jobs actually use: the picked count only when multi-worker helps, else 1. */
  readonly effectiveTtsWorkers = computed(() =>
    this.currentCaps().maxWorkers > 1 && this.workerCfg.enabled() && !this.ttsUsesGpu()
      ? this.ttsWorkers()
      : 1,
  );
  /** Whether the engine exposes XTTS-style sampling controls (drives the Advanced accordion). */
  readonly showAdvancedSampling = computed(() => {
    const s = this.currentCaps().sampling;
    return !!(s.temperature || s.topP || s.repetitionPenalty);
  });
  readonly ttsLanguageRows = signal<TtsLanguageRow[]>([]);
  readonly continueTts = signal(false);

  // Mono pipeline: single-voice TTS settings
  readonly monoTtsVoice = signal('ScarlettJohansson');
  readonly monoTtsSpeed = signal(1.0);

  // RVC voice enhancement (per-run): re-render the finished narration through a
  // matching RVC voice to smooth synthetic artifacts. Seeded from Pipeline
  // Defaults and persisted back on submit, so the queue (which reads the defaults
  // at job time) picks up the per-run choice. Only shown when the RVC engine is
  // installed.
  readonly rvcEnhanceEnabled = signal(false);
  readonly rvcEnhanceVoiceId = signal('');
  // RVC conversion knobs (Enhance & Assemble step). Persisted as defaults.
  readonly rvcEnhanceIndexRate = signal(0.5);
  readonly rvcEnhanceProtectRate = signal(0.5);
  readonly rvcEnhanceNSemitones = signal(0);

  // Final-audio denoise (per-run, OPT-IN): a block-based roformer pass over the
  // rendered sentences, run after generation and BEFORE any RVC pass / assembly, to
  // strip the faint background hiss hiss-bed-trained voices reproduce. Defaults OFF
  // for every engine — the user auditions the raw sentences (player below) and ticks
  // it only when needed; nothing is applied silently. The override signal keeps the
  // tick sticky within this wizard session. Deliberately NOT persisted to Pipeline
  // Defaults — those are engine-agnostic and a persisted global would defeat opt-in.
  readonly finalDenoiseOverride = signal<boolean | null>(null);
  readonly finalDenoise = computed(() => this.finalDenoiseOverride() ?? false);

  // De-ring (per-run, OPT-IN): apply the session voice's per-voice post-render ffmpeg
  // filter chain (the notch/comb that removes SNAC tonal ringing) at e2a's final
  // encode. Defaults OFF; only resolved+applied by the backend when this is ticked.
  // Sticky within the wizard session (plain signal). Only meaningful for Orpheus
  // sessions (the chain is resolved from provenance), a no-op otherwise.
  readonly applyDeRing = signal(false);

  // Raw-sentence audition (standalone reassembly only): the cached per-sentence FLACs
  // + their text, loaded so the user can play through and judge which of the three
  // opt-in passes (de-ring / denoise / RVC) are needed. RAW audio only — no processed
  // preview (denoise/RVC are GPU and must not run during audition). Loaded lazily from
  // the SAME cache the Correct-Sentences feature reads (getCorrectSentencesSession):
  // legacy sentence_{i}.flac sessions come back unavailable there, so the player simply
  // doesn't show for them — the toggles still do. null until loaded / when TTS-chained.
  readonly auditionSession = signal<CorrectSentencesSession | null>(null);
  readonly auditionLoading = signal(false);
  private auditionLoadedFor: string | null = null;

  // Pre-flight voice download status (shown near the Add to Queue button).
  readonly voiceDownloadMsg = signal<string | null>(null);
  readonly ttsTemperature = signal(STOCK_TTS_SAMPLING.temperature);
  readonly ttsTopP = signal(STOCK_TTS_SAMPLING.topP);
  readonly ttsRepetitionPenalty = signal(STOCK_TTS_SAMPLING.repetitionPenalty);
  /** Shown in the UI hint so the stock value is single-sourced. */
  readonly stockRepetitionPenalty = STOCK_TTS_SAMPLING.repetitionPenalty;
  readonly advancedTtsOpen = signal(false);

  // Orpheus memory tier — how much memory Orpheus may claim vs leave free for the
  // rest of the machine. Persisted per-machine in main; the buttons below set it.
  readonly orpheusMemTier = signal<string>('auto');
  readonly orpheusMemPlatform = signal<'mac' | 'nvidia'>('nvidia');
  // What 'auto' resolved to for this machine right now (shown on the Auto button).
  readonly orpheusMemResolved = signal<string>('');
  // Live GPU picture from the last tier query, so the UI can warn when the GPU is too
  // full to run Orpheus safely (viable:false → a job would be refused, not crash).
  readonly orpheusMemViable = signal<boolean>(true);
  readonly orpheusMemFreeMB = signal<number | null>(null);
  readonly orpheusMemUsedMB = signal<number | null>(null);
  // How much VRAM Orpheus will reserve at the resolved tier (bounded), so the UI can
  // show "uses ~X GB, leaves ~Y GB free".
  readonly orpheusMemReserveMB = signal<number | null>(null);
  // The selectable levels. Auto self-sizes per job (and reaches Extreme only on an
  // idle card); a manual pick is honored verbatim by the backend.
  readonly orpheusMemTiers: ReadonlyArray<{ id: string; name: string; sub: string }> = [
    { id: 'auto', name: 'Auto', sub: 'Self-sizing' },
    { id: 'extreme', name: 'Extreme', sub: 'All memory' },
    { id: 'fast', name: 'Fast', sub: 'Heavy memory' },
    { id: 'moderate', name: 'Moderate', sub: 'Some memory' },
    { id: 'light', name: 'Light', sub: 'Little memory' },
  ];
  // Display name for whatever 'auto' resolved to (e.g. 'extreme' → 'Extreme'), for the
  // Mac hint — Mac has no free-VRAM numbers to show, so it surfaces the resolved level.
  readonly orpheusMemResolvedName = computed(() => {
    const id = this.orpheusMemResolved();
    return this.orpheusMemTiers.find((t) => t.id === id)?.name ?? id;
  });

  /**
   * The language the narration is in: what the LAST translate pass leaves the book
   * in, or the book's own language when no pass translates it.
   */
  readonly monoTtsLanguage = computed(() => {
    const lastTranslate = [...this.passes()].reverse().find(p => p.translate);
    return lastTranslate?.translate?.targetLang ?? this.detectedSourceLang();
  });
  readonly partialTtsSessions = signal<{ language: string; completedSentences: number; totalSentences: number; sessionDir: string; sentencesDir: string }[]>([]);

  // Voices selectable for audiobook generation, loaded from the main process
  // (installed voices only — Default XTTS + installed fine-tuned/downloaded +
  // user custom — so every option actually works). Seeded with the always-present
  // bundled voice so the dropdown is never empty before the async load resolves.
  readonly xttsVoiceOptions = signal<{ value: string; label: string }[]>([
    { value: 'internal', label: 'Default XTTS' },
    { value: 'ScarlettJohansson', label: 'Scarlett Johansson' },
  ]);

  // Ordered best → worst prosody (user-ranked). Accent noted in the label. Built-in
  // voices seed the list; folder-discovered custom models (runtime/orpheus-models/)
  // are appended at init by loadOrpheusModels().
  readonly orpheusVoices = signal<{ value: string; label: string }[]>([
    { value: 'leah', label: 'Leah (Female, American)' },
    { value: 'tara', label: 'Tara (Female, American)' },
    { value: 'zoe', label: 'Zoe (Female, American)' },
    { value: 'mia', label: 'Mia (Female, American)' },
    { value: 'jess', label: 'Jess (Female, American)' },
    { value: 'zac', label: 'Zac (Male, American)' },
    { value: 'dan', label: 'Dan (Male, Cockney)' },
    { value: 'leo', label: 'Leo (Male, American)' },
  ]);

  /** Append folder-discovered custom Orpheus models as selectable voices. Labeled
   *  "(Custom)" so they're distinguishable from the built-ins. */
  private async loadOrpheusModels(): Promise<void> {
    try {
      const api = (window as any).electron?.orpheusModels;
      const res = await api?.list();
      if (!res?.success || !res.data?.length) return;
      const custom: { value: string; label: string }[] = res.data.map(
        (m: { id: string; label: string }) => ({ value: m.id, label: `${m.label} (Custom)` }),
      );
      // Drop any built-in colliding with a custom folder name, then append.
      const customValues = new Set(custom.map((c) => c.value));
      const builtins = this.orpheusVoices().filter((v) => !customValues.has(v.value));
      this.orpheusVoices.set([...builtins, ...custom]);
    } catch {
      // Discovery is best-effort — built-in voices remain available.
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: Assembly
  // ─────────────────────────────────────────────────────────────────────────

  readonly assemblySourceLang = signal<string>('');
  readonly assemblyTargetLang = signal<string>('');
  readonly assemblyPattern = signal<'interleaved' | 'sequential'>('interleaved');
  readonly pauseDuration = signal(0.5);
  readonly gapDuration = signal(1.0);
  readonly generateVideo = signal(false);
  readonly videoResolution = signal<'480p' | '720p' | '1080p'>('720p');
  readonly availableSessions = signal<SessionCache[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // EPUBs State
  // ─────────────────────────────────────────────────────────────────────────

  readonly scanningEpubs = signal(false);
  readonly availableEpubs = signal<AvailableEpub[]>([]);
  readonly stagesWithData = signal<Set<string>>(new Set());

  // ─────────────────────────────────────────────────────────────────────────
  // Connection/Model State
  // ─────────────────────────────────────────────────────────────────────────

  readonly ollamaConnected = signal(false);
  readonly checkingConnection = signal(true);
  readonly loadingModels = signal(false);
  readonly ollamaModels = signal<{ value: string; label: string }[]>([]);
  readonly claudeModels = signal<{ value: string; label: string }[]>([]);
  readonly openaiModels = signal<{ value: string; label: string }[]>([]);
  // Bundled llama.cpp models that are downloaded (value = catalog model id).
  readonly localModels = signal<{ value: string; label: string; active: boolean }[]>([]);

  // ─────────────────────────────────────────────────────────────────────────
  // Queue State
  // ─────────────────────────────────────────────────────────────────────────

  readonly addingToQueue = signal(false);
  readonly addedToQueue = signal(false);

  // ─────────────────────────────────────────────────────────────────────────
  // Computed Values
  // ─────────────────────────────────────────────────────────────────────────

  readonly hasClaudeKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.claude.apiKey;
  });

  readonly hasOpenAIKey = computed(() => {
    const config = this.settingsService.getAIConfig();
    return !!config.openai.apiKey;
  });

  /**
   * Unified AI source list for the cleanup/translate dropdowns. Only sources the
   * user has actually configured appear; each is its own optgroup. Option values
   * are encoded `${provider}::${model}` so one <select> drives provider + model.
   */
  readonly aiSourceGroups = computed<{ provider: AIProvider; label: string; models: { value: string; label: string; active?: boolean }[] }[]>(() => {
    const cfg = this.settingsService.getAIConfig();
    const groups: { provider: AIProvider; label: string; models: { value: string; label: string; active?: boolean }[] }[] = [];

    const local = this.localModels();
    if (local.length > 0) {
      groups.push({ provider: 'local', label: 'Bundled', models: local });
    }
    if (this.ollamaConnected() && this.ollamaModels().length > 0) {
      groups.push({ provider: 'ollama', label: 'Ollama', models: this.ollamaModels() });
    }
    if (this.hasClaudeKey()) {
      const m = this.claudeModels();
      groups.push({ provider: 'claude', label: 'Claude', models: m.length ? m : [{ value: cfg.claude.model || 'claude-sonnet-4-6', label: cfg.claude.model || 'Claude' }] });
    }
    if (this.hasOpenAIKey()) {
      const m = this.openaiModels();
      groups.push({ provider: 'openai', label: 'OpenAI', models: m.length ? m : [{ value: cfg.openai.model || 'gpt-4o', label: cfg.openai.model || 'OpenAI' }] });
    }
    return groups;
  });

  /** Current dropdown value for each step: `${provider}::${model}`. */
  readonly cleanupSelection = computed(() => `${this.cleanupProvider()}::${this.cleanupModel()}`);
  readonly translateSelection = computed(() => `${this.translateProvider()}::${this.translateModel()}`);

  // ── desktop-select option sources ───────────────────────────────────────────

  /**
   * Provider-grouped AI model options for the cleanup & translate dropdowns.
   * Mirrors the old <optgroup>/<option> structure: encoded `${provider}::${model}`
   * values, with " (active)" appended to the active model's label.
   */
  readonly aiModelGroups = computed<DesktopSelectOptionGroup[]>(() =>
    this.aiSourceGroups().map((group) => ({
      label: group.label,
      options: group.models.map((m) => ({
        value: `${group.provider}::${m.value}`,
        label: m.active ? `${m.label} (active)` : m.label,
      })),
    })),
  );

  /** Narration voice options for the current engine (mono + TTS-row voice selects). */
  readonly voiceOptions = computed<DesktopSelectItems>(() =>
    this.getVoicesForEngine().map((v) => ({ value: v.value, label: v.label })),
  );

  /** Installed RVC enhancement voices (kind 'rvc-model', state installed). */
  readonly installedRvcVoices = computed(() =>
    this.componentService.components().filter((c) => c.component.kind === 'rvc-model' && c.state === 'installed'),
  );
  readonly rvcVoiceOptions = computed<DesktopSelectItems>(() =>
    this.installedRvcVoices().map((c) => ({ value: c.component.id, label: c.component.name })),
  );

  /** Display label for an installed RVC voice id (falls back to the id if the
   *  voice isn't found — e.g. a preset referencing an un-downloaded voice). */
  rvcVoiceLabel(voiceId: string): string {
    return this.installedRvcVoices().find((c) => c.component.id === voiceId)?.component.name || voiceId;
  }

  /** Human label for a cached session's TTS provenance (engine + voice), shown in
   *  the assemble step so the user knows what produced the cached files. Honestly
   *  reports "Unknown" when the session predates provenance recording. */
  formatProvenance(provenance?: { ttsEngine?: string; voice?: string }): string {
    if (!provenance || (!provenance.ttsEngine && !provenance.voice)) {
      return 'Unknown (no provenance recorded)';
    }
    const engineNames: Record<string, string> = { xtts: 'XTTS', orpheus: 'Orpheus', f5: 'F5', voxtral: 'Voxtral' };
    const engine = provenance.ttsEngine ? (engineNames[provenance.ttsEngine] ?? provenance.ttsEngine) : '';
    const voice = provenance.voice || '';
    if (engine && voice) return `${engine} · ${voice}`;
    return engine || voice;
  }

  /** Load the raw-sentence audition set for the audition player. Reuses the
   *  Correct-Sentences read path (same IPC, same legacy-format handling) — RAW audio
   *  only, no processed preview. Silent on unavailability: the player just won't show. */
  private async loadAuditionSession(projectDir: string): Promise<void> {
    this.auditionLoading.set(true);
    try {
      const res = await this.electronService.correctSentencesGetSession(projectDir);
      const data = res?.success ? (res.data as CorrectSentencesSession | undefined) : undefined;
      this.auditionSession.set(data?.available && data.cues?.length ? data : null);
    } catch {
      // Audition is a convenience, never a gate — a load failure just hides the player.
      this.auditionSession.set(null);
    } finally {
      this.auditionLoading.set(false);
    }
  }

  // ── Pipeline presets ──────────────────────────────────────────────────────
  // Named bundles of TTS + RVC settings (e.g. "Owen on F5 → Sigma"). Picking one
  // from the dropdown applies engine/voice/sampling AND the enhancement choice in
  // one go; the user can save the current setup as a new preset.
  readonly pipelinePresets = signal<PipelinePreset[]>([]);
  /** The currently-applied preset id ('' = custom / none). Bound to the dropdown. */
  readonly selectedPresetId = signal<string>('');
  /** Dropdown options: every preset (built-ins first; placeholder shows when none applied). */
  readonly presetOptions = computed<DesktopSelectItems>(() =>
    this.pipelinePresets().map((p) => ({ value: p.id, label: p.name })),
  );
  /** True when the selected preset is a shipped built-in (hides the delete button). */
  readonly selectedPresetIsBuiltin = computed(() =>
    this.pipelinePresets().some((p) => p.id === this.selectedPresetId() && p.builtin),
  );
  /** The current wizard TTS + RVC selections as a preset payload. Drives both the
   *  "save" action and the divergence check that flips the dropdown to "custom". */
  readonly currentPresetConfig = computed<PipelinePresetConfig>(() => ({
    ttsEngine: this.ttsEngine(),
    ttsDevice: this.ttsDevice(),
    ttsVoice: this.monoTtsVoice(),
    ttsSpeed: this.monoTtsSpeed(),
    ttsTemperature: this.ttsTemperature(),
    ttsTopP: this.ttsTopP(),
    ttsRepetitionPenalty: this.ttsRepetitionPenalty(),
    rvcEnhancementEnabled: this.rvcEnhanceEnabled(),
    rvcEnhancementVoiceId: this.rvcEnhanceVoiceId(),
    rvcEnhancementIndexRate: this.rvcEnhanceIndexRate(),
    rvcEnhancementProtectRate: this.rvcEnhanceProtectRate(),
    rvcEnhancementNSemitones: this.rvcEnhanceNSemitones(),
  }));

  /** TTS-row language options. */
  readonly ttsLanguageOptions = computed<DesktopSelectItems>(() =>
    this.availableTtsLanguages().map((lang) => ({
      value: lang.code,
      label: `${lang.code.toUpperCase()} - ${lang.name}`,
    })),
  );

  /** Assembly "Source Sentences" options: cached sessions + pending TTS rows. */
  readonly assemblySourceOptions = computed<DesktopSelectItems>(() => {
    const opts: DesktopSelectItems = [];
    const sessions = this.availableSessions();
    if (sessions.length === 0) {
      opts.push({ value: '', label: 'No TTS sessions available' });
    }
    for (const session of sessions) {
      opts.push({
        value: session.language,
        label: `${session.language.toUpperCase()} (${session.sentenceCount} sentences)`,
      });
    }
    for (const lang of this.ttsLanguageRows()) {
      if (!this.hasSessionForLang(lang.language)) {
        opts.push({
          value: lang.language,
          label: `${lang.language.toUpperCase()} (will be created by TTS)`,
        });
      }
    }
    return opts;
  });

  /** Assembly "Target Sentences" options: excludes the chosen source language. */
  readonly assemblyTargetOptions = computed<DesktopSelectItems>(() => {
    const opts: DesktopSelectItems = [];
    const sessions = this.availableSessions();
    const source = this.assemblySourceLang();
    if (sessions.length === 0 && this.ttsLanguageRows().length <= 1) {
      opts.push({ value: '', label: 'No TTS sessions available' });
    }
    for (const session of sessions) {
      if (session.language !== source) {
        opts.push({
          value: session.language,
          label: `${session.language.toUpperCase()} (${session.sentenceCount} sentences)`,
        });
      }
    }
    for (const lang of this.ttsLanguageRows()) {
      if (!this.hasSessionForLang(lang.language) && lang.language !== source) {
        opts.push({
          value: lang.language,
          label: `${lang.language.toUpperCase()} (will be created by TTS)`,
        });
      }
    }
    return opts;
  });

  /** Everything the user could set up is set up → hide the "Configure AI" button. */
  readonly allAiConfigured = computed(() =>
    this.hasClaudeKey()
    && this.hasOpenAIKey()
    && (this.localModels().length > 0 || (this.ollamaConnected() && this.ollamaModels().length > 0))
  );

  /**
   * Effective project directory - uses projectDir if provided,
   * otherwise derives from epubPath or projectDir
   */
  readonly effectiveProjectDir = computed(() => {
    // Prefer explicit projectDir
    if (this.projectDir()) {
      return this.projectDir();
    }
    // Derive from epubPath (parent directory)
    if (this.epubPath()) {
      const normalized = this.epubPath().replace(/\\/g, '/');
      const parts = normalized.split('/');
      parts.pop(); // Remove filename
      return parts.join('/');
    }
    return '';
  });

  /**
   * Available languages for TTS - based on existing language EPUBs.
   * Detects which language EPUBs exist (en.epub, de.epub, etc.) and makes those available.
   */
  readonly availableTtsLanguages = computed(() => {
    const sourceLang = this.detectedSourceLang();
    const epubs = this.availableEpubs();
    const languageMap = new Map<string, string>();

    // Always include source language
    languageMap.set(sourceLang, this.getLanguageName(sourceLang));

    // Add any language EPUBs that exist (en.epub, de.epub, es.epub, etc.)
    for (const epub of epubs) {
      if (epub.isTranslated && epub.lang) {
        languageMap.set(epub.lang, this.getLanguageName(epub.lang));
      }
    }

    // Also add target languages from translation step if selected
    const targets = this.targetLangs();
    for (const code of targets) {
      if (!languageMap.has(code)) {
        languageMap.set(code, this.getLanguageName(code));
      }
    }

    // Convert to array format expected by template
    const languages: { code: string; name: string }[] = [];
    for (const [code, name] of languageMap) {
      languages.push({ code, name });
    }

    console.log('[LL-WIZARD] Available TTS languages:', languages);
    return languages;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  private isInitializing = true;

  constructor() {
    // Seed every picker from the user's Pipeline Defaults (Settings). Runs in the
    // constructor, before ngOnInit's session-restore, so a reopened in-progress
    // run still overrides these with its own saved selections.
    this.applyPipelineDefaults();
    this.pipelinePresets.set(this.settingsService.getPipelinePresets());

    // Keep the preset dropdown honest: once the user hand-edits any TTS/RVC control
    // away from the applied preset, flip it back to "custom" (empty selection). Reads
    // the config signals tracked; reads the selection/list untracked to avoid a loop.
    effect(() => {
      const cfg = this.currentPresetConfig();
      const id = untracked(() => this.selectedPresetId());
      if (!id) return;
      const preset = untracked(() => this.pipelinePresets()).find((p) => p.id === id);
      if (!preset || !this.presetMatchesConfig(preset, cfg)) {
        this.selectedPresetId.set('');
      }
    });

    // Re-scan project EPUBs whenever project dir changes (e.g. after exporting from PDF viewer)
    effect(() => {
      const dir = this.effectiveProjectDir();
      this.refreshTrigger();  // re-scan stages when the host bumps this (after delete/reset)
      if (dir) this.scanProjectEpubs();
    });

    // The pass builder's book list, from the same place the metadata page reads it.
    effect(() => {
      const dir = this.effectiveProjectDir();
      this.projectId();
      this.refreshTrigger();
      if (dir) void untracked(() => this.loadVariantCards());
    });

    // Re-plan on every edit to the run, debounced: the answer comes from main and
    // a keystroke-rate round trip would show a refusal for an order the user is
    // still in the middle of typing.
    effect(() => {
      const dir = this.effectiveProjectDir();
      const variantId = this.selectedVariantId();
      const list = this.passes();
      const mono = this.pipelineMode() === 'mono';
      if (this.planTimer) clearTimeout(this.planTimer);
      if (!mono || !dir || list.length === 0) {
        this.chainPlan.set(null);
        this.chainError.set(null);
        this.planning.set(false);
        return;
      }
      this.planning.set(true);
      this.planTimer = setTimeout(() => void this.replanChain(dir, variantId, list), 350);
    });

    // Keep the narration source honest: a queued pass rewrites the book, so once
    // there are passes the only coherent input is what they produce.
    effect(() => {
      const producing = this.runProducesEpub();
      const book = this.bookEpubPath();
      const hasPasses = this.passes().length > 0;
      untracked(() => {
        if (hasPasses && producing) this.ttsInput.set('run');
        else if (book) this.ttsInput.set('book');
      });
    });

    // The translate pass's default direction: out of the book's own language.
    effect(() => {
      const detected = this.detectedSourceLang();
      untracked(() => {
        this.passTranslateSource.set(detected);
        if (this.passTranslateTarget() === detected) {
          this.passTranslateTarget.set(detected === 'en' ? 'de' : 'en');
        }
      });
    });

    // Default the cleanup stage picker from the project's import provenance. Keyed on
    // the project dir too, so switching to a different book re-decides (and clears the
    // previous book's manual override) instead of carrying the last choice over.
    effect(() => {
      const dir = this.effectiveProjectDir();
      this.sourceType();
      if (dir !== untracked(() => this.cleanupStagesDefaultedFor)) {
        this.cleanupStagesDefaultedFor = dir;
        this.cleanupStagesTouched = false;
      }
      untracked(() => this.syncCleanupStagesDefault());
    });

    // Host (Versions "Continue") bumps continueRequest → jump to the TTS step with the
    // original run's settings pre-filled and Cleanup/Translate disabled.
    effect(() => {
      const req = this.continueRequest();
      if (req > 0 && req !== untracked(() => this.continueRequestHandled)) {
        this.continueRequestHandled = req;
        void this.enterContinueMode();
      }
    });

    // Host (the picker's Next, or a document row's Process) bumps
    // narrationRequest → stand on the TTS step. Untracked so that walking the
    // steps, which reads `currentStep`, cannot make this effect its own trigger.
    effect(() => {
      const req = this.narrationRequest();
      if (req > 0 && req !== untracked(() => this.narrationRequestHandled)) {
        this.narrationRequestHandled = req;
        untracked(() => this.landOnNarration());
      }
    });

    // Seed the pipeline's worker count from the global multi-worker setting once
    // it loads, so it "defaults to whatever they have in Settings" — until the
    // user picks a different count here.
    effect(() => {
      const cfg = this.workerCfg.config();
      if (cfg && !this.workerCountTouched && this.ttsEngine() === 'xtts') {
        this.ttsWorkers.set(this.workerCfg.effectiveCount());
      }
    });

    // Load the raw-sentence audition set once the user reaches the Assembly step of a
    // STANDALONE reassembly (mono, TTS skipped, cached session present). Keyed on the
    // cached session's process dir so it loads once and re-loads only if that changes.
    // Chained (TTS→assemble) runs have no cached sentences yet → no player, just toggles.
    effect(() => {
      const onAssembly = this.currentStep() === 'assembly';
      const mono = this.pipelineMode() === 'mono';
      const session = this.cachedSession();
      const chained = !this._skippedSteps.has('tts');
      const projectDir = untracked(() => this.projectDir());
      if (!onAssembly || !mono || !session || chained || !projectDir) return;
      if (this.auditionLoadedFor === projectDir) return;
      this.auditionLoadedFor = projectDir;
      void this.loadAuditionSession(projectDir);
    });

    // Sync TTS language rows when target languages change (bilingual pipeline only)
    effect(() => {
      // Skip during initialization to avoid conflicts
      if (this.isInitializing) return;
      if (this.pipelineMode() !== 'bilingual') return;

      const targets = this.targetLangs();
      const sourceLang = this.detectedSourceLang();
      this.syncTtsRowsWithTargets(sourceLang, targets);
    });
  }

  async ngOnInit(): Promise<void> {
    console.log('[LL-WIZARD] Component initializing with:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());

    this.detectedSourceLang.set(this.initialSourceLang());
    this.initializeFromSettings();
    // Folder-discovered custom Orpheus models → extra voices (best-effort, async).
    void this.loadOrpheusModels();
    // Current Orpheus memory tier (persisted per-machine).
    void this.electronService.getOrpheusMemoryTier().then((r) => this.applyMemoryTierReply(r));
    // Optional engines: if a saved/default engine isn't installed, fall back to XTTS.
    await this.componentService.ensureLoaded();
    if (this.ttsEngine() === 'orpheus' && !this.componentService.isInstalled('orpheus')) {
      this.selectTtsEngine('xtts');
    }
    // Load the TTS voice list FIRST and independently — it must never be gated
    // behind AI/Ollama init. Previously this ran last in the chain, so if Ollama
    // was down (checkOllamaConnection rejecting) the whole tail was skipped and the
    // picker kept its 2-voice seed (Scarlett + Default) — the fine-tuned/downloadable
    // voices like Owen Morgan never appeared.
    await this.loadXttsVoiceOptions();

    // AI/Ollama init is best-effort: a failure here must not abort the rest of
    // setup (voices already loaded; epubs/sessions/rows still need to run).
    try {
      await this.ai.refresh();
      await this.checkOllamaConnection();
      await this.loadLocalModels();
      this.normalizeAiSelections();
    } catch (err) {
      console.warn('[LL-WIZARD] AI init failed (non-fatal):', err);
    }

    // EPUBs are scanned by the projectDir effect — await a tick for it to complete
    await this.scanProjectEpubs();
    this.scanAvailableSessions();
    this.initializeDefaultTtsRows();

    console.log('[LL-WIZARD] After initialization:');
    console.log('[LL-WIZARD]   enableAiCleanup:', this.enableAiCleanup());
    console.log('[LL-WIZARD]   simplifyForLearning:', this.simplifyForLearning());

    // Allow effects to run now that initialization is complete
    this.isInitializing = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  private initializeFromSettings(): void {
    const config = this.settingsService.getAIConfig();

    // Default to Ollama
    this.cleanupProvider.set('ollama');
    this.cleanupModel.set(config.ollama.model || 'cogito:14b');
    this.translateProvider.set('ollama');
    this.translateModel.set(config.ollama.model || 'cogito:14b');

    // Pre-fetch other providers' models
    if (config.claude.apiKey) {
      this.fetchClaudeModels(config.claude.apiKey);
    }
    if (config.openai.apiKey) {
      this.fetchOpenAIModels(config.openai.apiKey);
    }
  }

  private initializeDefaultTtsRows(): void {
    const sourceLang = this.detectedSourceLang();
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'leah' : 'ScarlettJohansson';
    const rows: TtsLanguageRow[] = [];
    const timestamp = Date.now();

    // First row: Source language (e.g., English)
    rows.push({
      id: `tts-${timestamp}-${sourceLang}`,
      language: sourceLang,
      voice: defaultVoice,
      speed: 1.0
    });

    // Second row: First target language (if available from translation config)
    // This will be populated based on selected target languages
    // We don't need to check for EPUBs here - that happens at runtime

    console.log('[LL-WIZARD] Initialized TTS rows:', rows);
    this.ttsLanguageRows.set(rows);

    // If we have TTS rows configured, remove from skipped steps
    if (rows.length > 0) {
      this._skippedSteps.delete('tts');
    }
  }

  private syncTtsRowsWithTargets(sourceLang: string, targets: Set<string>): void {
    // Skip if we haven't initialized yet
    if (this.availableEpubs().length === 0) {
      return;
    }

    const currentRows = this.ttsLanguageRows();
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'leah' : 'ScarlettJohansson';
    const epubs = this.availableEpubs();

    // Ensure source language row exists
    const hasSource = currentRows.some(r => r.language === sourceLang);
    if (!hasSource && currentRows.length === 0) {
      const sourceEpub = epubs.find(e => e.isTranslated && e.lang === sourceLang);
      const sourceEpubPath = sourceEpub ? sourceEpub.path : 'latest';

      this.ttsLanguageRows.update(rows => [...rows, {
        id: `tts-${Date.now()}`,
        language: sourceLang,
        sourceEpub: sourceEpubPath,
        voice: defaultVoice,
        speed: 1.0
      }]);
    }

    // Add rows for new target languages
    for (const lang of targets) {
      const hasLang = currentRows.some(r => r.language === lang);
      if (!hasLang) {
        const targetEpub = epubs.find(e => e.isTranslated && e.lang === lang);
        const targetEpubPath = targetEpub ? targetEpub.path : 'latest';

        this.ttsLanguageRows.update(rows => [...rows, {
          id: `tts-${Date.now()}-${lang}`,
          language: lang,
          sourceEpub: targetEpubPath,
          voice: defaultVoice,
          speed: 0.85 // Slower for target language
        }]);
      }
    }
  }

  async checkOllamaConnection(): Promise<void> {
    this.checkingConnection.set(true);
    try {
      const response = await fetch('http://localhost:11434/api/tags').catch(() => null);
      if (response?.ok) {
        this.ollamaConnected.set(true);
        const data = await response.json();
        const models: { value: string; label: string }[] = (data.models || []).map((m: { name: string }) => ({
          value: m.name,
          label: m.name
        }));
        this.ollamaModels.set(models);

        // If the current model isn't in the fetched list, reset to preferred default
        if (models.length > 0) {
          const preferred = models.find(m => m.value === 'cogito:14b')?.value ?? models[0].value;
          if (!this.cleanupModel() || !models.some(m => m.value === this.cleanupModel())) {
            this.cleanupModel.set(preferred);
          }
          if (!this.translateModel() || !models.some(m => m.value === this.translateModel())) {
            this.translateModel.set(preferred);
          }
        }
      } else {
        this.ollamaConnected.set(false);
      }
    } catch {
      this.ollamaConnected.set(false);
    } finally {
      this.checkingConnection.set(false);
    }
  }

  async fetchClaudeModels(apiKey: string): Promise<void> {
    if (!apiKey) return;
    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getClaudeModels(apiKey);
      if (result.success && result.models) {
        this.claudeModels.set(result.models);
      }
    } catch (err) {
      console.error('Failed to fetch Claude models:', err);
    } finally {
      this.loadingModels.set(false);
    }
  }

  async fetchOpenAIModels(apiKey: string): Promise<void> {
    if (!apiKey) return;
    this.loadingModels.set(true);
    try {
      const result = await this.electronService.getOpenAIModels(apiKey);
      if (result.success && result.models) {
        this.openaiModels.set(result.models);
      }
    } catch (err) {
      console.error('Failed to fetch OpenAI models:', err);
    } finally {
      this.loadingModels.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EPUB Scanning
  // ─────────────────────────────────────────────────────────────────────────

  async scanProjectEpubs(): Promise<void> {
    const projectDir = this.effectiveProjectDir();

    if (!projectDir) {
      this.availableEpubs.set([]);
      return;
    }

    console.log('[LL-WIZARD] Scanning for EPUBs in unified structure:', projectDir);
    this.scanningEpubs.set(true);
    try {
      const epubs: AvailableEpub[] = [];

      // Scan translation stage for language EPUBs
      try {
        const translationDir = `${projectDir}/stages/02-translate`;
        const translationFiles = await this.electronService.listDirectory(translationDir);
        for (const file of translationFiles) {
          if (file.endsWith('.epub') && !file.startsWith('._') && !file.startsWith('.')) {
            const filePath = `${translationDir}/${file}`;
            const lang = this.detectLanguageFromFilename(file);
            const isLangEpub = /^[a-z]{2}\.epub$/i.test(file);

            epubs.push({
              path: filePath,
              filename: file,
              lang: lang,
              isSource: false,
              isTranslated: isLangEpub,
              isCleaned: false
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No translation stage found');
      }

      // Scan cleanup stage
      try {
        const cleanupDir = `${projectDir}/stages/01-cleanup`;
        const cleanupFiles = await this.electronService.listDirectory(cleanupDir);
        for (const file of cleanupFiles) {
          // repaired.epub is pass 1's output — faithful text with scanner damage
          // fixed and every footnote marker still in place. Offering it as a source
          // means a TTS-prep re-run (OCR repair off, seconds) can redo the footnote
          // and number work without paying for the model pass a second time.
          if (file === 'cleaned.epub' || file === 'simplified.epub' || file === 'repaired.epub') {
            const filePath = `${cleanupDir}/${file}`;
            epubs.push({
              path: filePath,
              filename: file,
              lang: 'en',
              isSource: false,
              isTranslated: false,
              isCleaned: true
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No cleanup stage found');
      }

      // Scan source folder
      try {
        const sourceDir = `${projectDir}/source`;
        const sourceFiles = await this.electronService.listDirectory(sourceDir);
        for (const file of sourceFiles) {
          if (file === 'original.epub' && !file.startsWith('._')) {
            const filePath = `${sourceDir}/${file}`;
            epubs.push({
              path: filePath,
              filename: file,
              lang: 'en',
              isSource: true,
              isTranslated: false,
              isCleaned: false
            });
          }
        }
      } catch (err) {
        console.log('[LL-WIZARD] No source folder found');
      }

      // The project's own export, from its manifest record. `filename` here is
      // the wizard's STAGE KEY (what STAGE_ORDER and the source dropdowns match
      // on), not the name on disk — the file is named after the book now, and
      // `path` is the only thing that points at it.
      try {
        const info = await this.electronService.projectsExportInfo(projectDir);
        if (info.exported) {
          epubs.push({
            path: info.exported.absPath,
            filename: 'exported.epub',
            lang: 'en',
            isSource: true,
            isTranslated: false,
            isCleaned: false
          });
        }
      } catch (err) {
        console.warn('[LL-WIZARD] Could not resolve the project export:', (err as Error).message);
      }

      // Enrich with mtime for "Latest" resolution
      if (epubs.length > 0) {
        const statResults = await this.electronService.fsBatchStat(epubs.map(e => e.path));
        for (const epub of epubs) {
          const stat = statResults[epub.path];
          if (stat) {
            epub.mtimeMs = stat.mtimeMs;
            epub.modifiedAt = new Date(stat.mtimeMs).toISOString();
          }
        }
      }

      console.log('[LL-WIZARD] Scanned EPUBs:', epubs.map(e => ({
        filename: e.filename,
        lang: e.lang,
        isTranslated: e.isTranslated,
        isSource: e.isSource,
        mtimeMs: e.mtimeMs
      })));
      this.availableEpubs.set(epubs);

      // Detect which stages have existing data
      const dataSet = new Set<string>();
      if (epubs.some(e => e.isCleaned)) {
        dataSet.add('cleanup');
      }
      if (epubs.some(e => e.isTranslated)) {
        dataSet.add('translate');
      }

      // Check TTS cache and output via batch exists
      const ttsDir = `${projectDir}/stages/03-tts/sessions`;
      const outputDir = `${projectDir}/output`;
      const existsMap = await this.electronService.fsBatchExists([ttsDir, outputDir]);
      if (existsMap[ttsDir]) dataSet.add('tts');
      if (existsMap[outputDir]) dataSet.add('assembly');

      this.stagesWithData.set(dataSet);
    } catch (err) {
      console.error('Failed to scan project EPUBs:', err);
      this.availableEpubs.set([]);
    } finally {
      this.scanningEpubs.set(false);
    }
  }

  /** Delete existing cleanup output so the next run starts fresh */
  /** Open the AI Setup wizard from the cleanup-step layover. */
  openAiSetup(): void {
    void this.router.navigate(['/ai-setup']);
  }

  /** Open Settings → XTTS (language packs) to manage the full language-pack catalog. */
  openLanguageSettings(): void {
    void this.router.navigate(['/settings'], { queryParams: { section: 'xtts' } });
  }

  async clearCleanupStage(): Promise<void> {
    const projectDir = this.effectiveProjectDir();
    if (!projectDir) return;

    const electron = (window as any).electron;
    if (!electron?.pipeline?.deleteCleanup) return;

    const result = await electron.pipeline.deleteCleanup(projectDir);
    if (result.success) {
      console.log('[LLWizard] Cleanup stage cleared:', result.message);
      await this.scanProjectEpubs();
    } else {
      console.error('[LLWizard] Failed to clear cleanup stage:', result.error);
    }
  }

  private detectLanguageFromFilename(filename: string): string {
    const match = filename.match(/^([a-z]{2})\.epub$/i);
    if (match) {
      return match[1].toLowerCase();
    }
    return this.initialSourceLang();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Scanning (for Assembly)
  // ─────────────────────────────────────────────────────────────────────────

  async scanAvailableSessions(): Promise<void> {
    this.availableSessions.set([]);

    // Scan project directory for cached TTS sessions
    const projectDir = this.effectiveProjectDir();
    if (projectDir) {
      try {
        const electron = (window as any).electron;
        if (electron?.sessionCache?.scanProject) {
          const result = await electron.sessionCache.scanProject(projectDir);
          if (result.success && result.sessions.length > 0) {
            const sessions: SessionCache[] = result.sessions.map((s: any) => ({
              language: s.language,
              sessionDir: s.sentencesDir, // Use sentences dir as the session path for assembly
              sentenceCount: s.sentenceCount,
              createdAt: s.createdAt,
            }));
            this.availableSessions.set(sessions);
            console.log('[LL-WIZARD] Found cached sessions:', sessions.map(s => `${s.language} (${s.sentenceCount} sentences)`));
          }
        }
      } catch (err) {
        console.error('[LL-WIZARD] Error scanning sessions:', err);
      }
    }

    // Auto-populate assembly source/target from available sessions or TTS rows
    const sourceLang = this.detectedSourceLang();

    if (!this.assemblySourceLang()) {
      const sourceSession = this.availableSessions().find(s => s.language === sourceLang);
      const sourceRow = this.ttsLanguageRows().find(r => r.language === sourceLang);
      if (sourceSession || sourceRow) {
        this.assemblySourceLang.set(sourceLang);
      }
    }

    if (!this.assemblyTargetLang()) {
      const targetSession = this.availableSessions().find(s => s.language !== sourceLang);
      const targetRow = this.ttsLanguageRows().find(r => r.language !== sourceLang);
      if (targetSession) {
        this.assemblyTargetLang.set(targetSession.language);
      } else if (targetRow) {
        this.assemblyTargetLang.set(targetRow.language);
      }
    }

    // If both are now set, remove from skipped steps
    if (this.assemblySourceLang() && this.assemblyTargetLang()) {
      this._skippedSteps.delete('assembly');
    }
  }

  hasSessionForLang(lang: string): boolean {
    return this.availableSessions().some(s => s.language === lang);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Selection
  // ─────────────────────────────────────────────────────────────────────────

  /** Parse a `${provider}::${model}` dropdown value. */
  private parseSelection(value: string): { provider: AIProvider; model: string } {
    const i = value.indexOf('::');
    const provider = (i >= 0 ? value.slice(0, i) : value) as AIProvider;
    const model = i >= 0 ? value.slice(i + 2) : '';
    return { provider, model };
  }

  onCleanupModelChange(value: string): void {
    const { provider, model } = this.parseSelection(value);
    this.cleanupProvider.set(provider);
    this.cleanupModel.set(model);
    // Bundled llama.cpp serves whichever model is "active" — selecting one here
    // promotes it so the cleanup job actually runs against that model.
    if (provider === 'local') void this.ai.setActiveModel(model);
  }

  onTranslateModelChange(value: string): void {
    const { provider, model } = this.parseSelection(value);
    this.translateProvider.set(provider);
    this.translateModel.set(model);
    if (provider === 'local') void this.ai.setActiveModel(model);
  }

  /** Load downloaded bundled (llama.cpp) models into the unified picker. */
  private async loadLocalModels(): Promise<void> {
    const models = await this.ai.listLocalModels();
    this.localModels.set(
      models
        .filter((m) => m.downloaded)
        .map((m) => ({ value: m.id, label: `${m.name} · ${m.sizeGB} GB`, active: m.isActive }))
    );
  }

  /**
   * Ensure each step's saved provider/model still points at an available option;
   * if not, fall back to the active bundled model, else the first available source.
   * (The default from settings may name an unconfigured provider.)
   */
  private normalizeAiSelections(): void {
    const groups = this.aiSourceGroups();
    if (groups.length === 0) return;
    const has = (provider: string, model: string) =>
      groups.some((g) => g.provider === provider && g.models.some((m) => m.value === model));

    const localGroup = groups.find((g) => g.provider === 'local');
    const def = localGroup
      ? { provider: 'local' as AIProvider, model: (localGroup.models.find((m) => m.active) ?? localGroup.models[0]).value }
      : { provider: groups[0].provider, model: groups[0].models[0]?.value ?? '' };

    if (!has(this.cleanupProvider(), this.cleanupModel())) {
      this.cleanupProvider.set(def.provider);
      this.cleanupModel.set(def.model);
    }
    if (!has(this.translateProvider(), this.translateModel())) {
      this.translateProvider.set(def.provider);
      this.translateModel.set(def.model);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Translation
  // ─────────────────────────────────────────────────────────────────────────

  isTargetLangSelected(code: string): boolean {
    return this.targetLangs().has(code);
  }

  toggleTargetLang(code: string): void {
    const current = new Set(this.targetLangs());
    if (current.has(code)) {
      current.delete(code);
    } else {
      current.add(code);
    }
    this.targetLangs.set(current);

    // If we have target languages selected, remove 'translate' from skipped steps
    if (current.size > 0) {
      this._skippedSteps.delete('translate');
    }
  }

  async deleteTranslationEpub(epub: AvailableEpub): Promise<void> {
    const projectDir = this.effectiveProjectDir();
    if (!projectDir) return;

    // Delete the EPUB file
    await this.electronService.deleteFile(epub.path);

    // Delete the corresponding sentence cache
    await this.electronService.deleteFile(`${projectDir}/stages/02-translate/sentences/${epub.lang}.json`);

    // Delete the TTS session folder for this language (contains wav/flac audio)
    await this.electronService.deleteDirectory(`${projectDir}/stages/03-tts/sessions/${epub.lang}`);

    // Delete the sentence pairs file (may be stale)
    await this.electronService.deleteFile(`${projectDir}/stages/02-translate/sentence_pairs_${epub.lang}.json`);

    // Re-scan EPUBs and sessions to update all UI
    await this.scanProjectEpubs();
    await this.scanAvailableSessions();
  }

  async deleteAllTranslationEpubs(): Promise<void> {
    const epubs = [...this.existingTranslationEpubs()];
    for (const epub of epubs) {
      await this.deleteTranslationEpub(epub);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TTS
  // ─────────────────────────────────────────────────────────────────────────

  /** Seed every picker from Settings → Pipeline Defaults. */
  private applyPipelineDefaults(): void {
    const d = this.settingsService.getPipelineDefaults();
    this.cleanupProvider.set(d.cleanupProvider);
    this.cleanupModel.set(d.cleanupModel);
    this.translateProvider.set(d.translateProvider);
    this.translateModel.set(d.translateModel);
    this.ttsEngine.set(d.ttsEngine);
    this.ttsDevice.set(d.ttsDevice);
    this.monoTtsVoice.set(d.ttsVoice);
    this.monoTtsSpeed.set(d.ttsSpeed);
    this.ttsTemperature.set(d.ttsTemperature);
    this.ttsTopP.set(d.ttsTopP);
    this.ttsRepetitionPenalty.set(d.ttsRepetitionPenalty);
    this.generateVideo.set(d.generateVideo);
    this.rvcEnhanceEnabled.set(d.rvcEnhancementEnabled);
    this.rvcEnhanceVoiceId.set(d.rvcEnhancementVoiceId);
    this.rvcEnhanceIndexRate.set(d.rvcEnhancementIndexRate);
    this.rvcEnhanceProtectRate.set(d.rvcEnhancementProtectRate);
    this.rvcEnhanceNSemitones.set(d.rvcEnhancementNSemitones ?? 0);
    void this.componentService.ensureLoaded();
  }

  // ── Pipeline presets ──────────────────────────────────────────────────────

  /** True when a saved preset's settings equal the given current config. */
  private presetMatchesConfig(preset: PipelinePreset, cfg: PipelinePresetConfig): boolean {
    return (
      preset.ttsEngine === cfg.ttsEngine &&
      preset.ttsDevice === cfg.ttsDevice &&
      preset.ttsVoice === cfg.ttsVoice &&
      preset.ttsSpeed === cfg.ttsSpeed &&
      preset.ttsTemperature === cfg.ttsTemperature &&
      preset.ttsTopP === cfg.ttsTopP &&
      preset.ttsRepetitionPenalty === cfg.ttsRepetitionPenalty &&
      preset.rvcEnhancementEnabled === cfg.rvcEnhancementEnabled &&
      preset.rvcEnhancementVoiceId === cfg.rvcEnhancementVoiceId &&
      preset.rvcEnhancementIndexRate === cfg.rvcEnhancementIndexRate &&
      preset.rvcEnhancementProtectRate === cfg.rvcEnhancementProtectRate &&
      preset.rvcEnhancementNSemitones === cfg.rvcEnhancementNSemitones
    );
  }

  /** Apply a saved preset to every TTS + RVC control. Bound to the preset dropdown. */
  applyPreset(id: string): void {
    if (!id) { this.selectedPresetId.set(''); return; }
    const preset = this.pipelinePresets().find((p) => p.id === id);
    if (!preset) return;

    // Route the engine through selectTtsEngine first so its constraints (device,
    // workers, voice kind) are set up, THEN override with the preset's exact values.
    this.selectTtsEngine(preset.ttsEngine);
    this.ttsDevice.set(preset.ttsDevice);
    this.monoTtsVoice.set(preset.ttsVoice);
    this.monoTtsSpeed.set(preset.ttsSpeed);
    this.ttsTemperature.set(preset.ttsTemperature);
    this.ttsTopP.set(preset.ttsTopP);
    this.ttsRepetitionPenalty.set(preset.ttsRepetitionPenalty);
    this.rvcEnhanceEnabled.set(preset.rvcEnhancementEnabled);
    this.rvcEnhanceVoiceId.set(preset.rvcEnhancementVoiceId);
    this.rvcEnhanceIndexRate.set(preset.rvcEnhancementIndexRate);
    this.rvcEnhanceProtectRate.set(preset.rvcEnhancementProtectRate);
    this.rvcEnhanceNSemitones.set(preset.rvcEnhancementNSemitones ?? 0);

    // Set the selection LAST so the divergence effect settles with the dropdown
    // pointing at this preset (current config now equals it).
    this.selectedPresetId.set(id);
  }

  /** Name and save the current TTS + RVC selections as a reusable preset. */
  async saveCurrentAsPreset(): Promise<void> {
    const name = await this.dialog.prompt({
      title: 'Save pipeline preset',
      message: 'Name this voice + enhancement setup so you can pick it again from the dropdown.',
      placeholder: 'e.g. Owen on F5 → Sigma',
      confirmLabel: 'Save preset',
    });
    if (!name) return;

    // A matching name overwrites that preset (after confirming); otherwise mint one.
    // Built-ins are never matched — saving over a built-in name mints a user copy.
    const existing = this.pipelinePresets().find(
      (p) => !p.builtin && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      const ok = await this.dialog.confirm({
        title: 'Replace preset',
        message: `A preset named "${existing.name}" already exists. Replace it with the current settings?`,
        type: 'warning',
        confirmLabel: 'Replace',
      });
      if (!ok) return;
    }

    const id = existing?.id ?? `preset-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const preset: PipelinePreset = { id, name, ...this.currentPresetConfig() };
    this.pipelinePresets.set(this.settingsService.savePipelinePreset(preset));
    this.selectedPresetId.set(id);
  }

  /** Delete the currently-selected preset (after confirming). */
  async deleteSelectedPreset(): Promise<void> {
    const id = this.selectedPresetId();
    const preset = this.pipelinePresets().find((p) => p.id === id);
    if (!preset || preset.builtin) return;
    const ok = await this.dialog.confirm({
      title: 'Delete preset',
      message: `Delete the preset "${preset.name}"?`,
      detail: 'This only removes the saved preset — your current settings stay as they are.',
      type: 'warning',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    this.pipelinePresets.set(this.settingsService.deletePipelinePreset(id));
    this.selectedPresetId.set('');
  }

  /** Reset the XTTS sampling sliders to the factory ("stock") values. The user's
   *  saved defaults only change when they move a slider; this restores stock. */
  resetTtsToStock(): void {
    this.ttsTemperature.set(STOCK_TTS_SAMPLING.temperature);
    this.ttsTopP.set(STOCK_TTS_SAMPLING.topP);
    this.ttsRepetitionPenalty.set(STOCK_TTS_SAMPLING.repetitionPenalty);
    this.monoTtsSpeed.set(STOCK_TTS_SAMPLING.speed);
  }

  /** Set the Orpheus memory level (persisted per-machine, applied to the next job).
   *  'auto' self-sizes; a concrete level is honored verbatim by the backend. */
  async setOrpheusMemTier(tier: string): Promise<void> {
    const prev = this.orpheusMemTier();
    this.orpheusMemTier.set(tier); // optimistic
    const r = await this.electronService.setOrpheusMemoryTier(tier);
    if (r && typeof r === 'object') this.applyMemoryTierReply(r);
    else this.orpheusMemTier.set(prev); // not in Electron / failed
  }

  /** Fold a getMemoryTier reply into the local signals. */
  private applyMemoryTierReply(r: unknown): void {
    if (!r || typeof r !== 'object') return;
    const o = r as {
      tier?: string; resolvedTier?: string; platform?: 'mac' | 'nvidia';
      viable?: boolean; freeMB?: number | null; usedMB?: number | null; reserveMB?: number | null;
    };
    if (o.tier) this.orpheusMemTier.set(o.tier);
    if (o.platform) this.orpheusMemPlatform.set(o.platform);
    if (o.resolvedTier) this.orpheusMemResolved.set(o.resolvedTier);
    if (typeof o.viable === 'boolean') this.orpheusMemViable.set(o.viable);
    this.orpheusMemFreeMB.set(o.freeMB ?? null);
    this.orpheusMemUsedMB.set(o.usedMB ?? null);
    this.orpheusMemReserveMB.set(o.reserveMB ?? null);
  }

  /** MB → "X.X GB" for the memory hints. */
  gb(mb: number | null): string {
    return mb == null ? '?' : (mb / 1024).toFixed(1);
  }

  async setTtsWorkers(count: number): Promise<void> {
    // On a CUDA machine the GPU serializes decode, so >1 worker only contends.
    // Confirm with a native dialog before accepting it here.
    if (count > 1 && this.workerCfg.isCudaMachine()) {
      const { confirmed } = await this.electronService.showConfirmDialog({
        type: 'warning',
        title: 'Multiple workers won’t help on this GPU',
        message: 'Your NVIDIA GPU runs TTS decode one step at a time.',
        detail: `Using ${count} workers on a CUDA GPU just makes them compete for the GPU (and costs ~5 GB RAM each) without generating any faster. Use ${count} anyway?`,
        confirmLabel: `Use ${count}`,
        cancelLabel: 'Keep 1',
      });
      if (!confirmed) {
        this.workerCountTouched = true;
        this.ttsWorkers.set(1);
        return;
      }
    }
    this.workerCountTouched = true;
    this.ttsWorkers.set(count);
  }

  /** Whether an engine is selectable now (bundled, or its env component is installed). */
  protected engineAvailable(eng: TtsEngineCaps): boolean {
    return eng.requiresComponent === null || this.componentService.isInstalled(eng.requiresComponent);
  }

  selectTtsEngine(engine: TTSEngine): void {
    this.ttsEngine.set(engine);
    const caps = engineCaps(engine);

    // Auto-apply the engine's constraints so the user never sees a choice it can't
    // honor. 1-worker engines (vLLM: Orpheus/Voxtral) force a single worker; the
    // worker picker is hidden for them anyway (maxWorkers <= 1).
    if (caps.maxWorkers <= 1) {
      this.ttsWorkers.set(1);
    }
    // GPU-only engines must not sit on a CPU device — move off CPU to the platform
    // GPU ('auto' already resolves to CUDA/MPS, so only an explicit CPU needs fixing).
    if (!caps.device.cpuCapable && this.ttsDevice() === 'cpu') {
      this.ttsDevice.set(this.isMac ? 'mps' : 'gpu');
    }

    // Default voice: the engine's first preset (Orpheus/Voxtral), else the default
    // catalog voice (XTTS/F5 clone from a reference clip).
    const defaultVoice = caps.voices.kind === 'preset' && caps.voices.presets?.length
      ? caps.voices.presets[0].id
      : 'ScarlettJohansson';
    this.monoTtsVoice.set(defaultVoice);
    this.ttsLanguageRows.update(rows =>
      rows.map(row => ({ ...row, voice: defaultVoice }))
    );
  }

  /**
   * Load the audiobook voice picker from the main process — installed voices
   * only (Default XTTS + installed fine-tuned/downloaded + user custom), so every
   * option works. Replaces the old hardcoded list, which could offer voices whose
   * reference clip was no longer bundled.
   */
  private async loadXttsVoiceOptions(): Promise<void> {
    try {
      const api = (window as any).electron?.customVoices;
      if (!api?.listAudiobook) return;
      const res = await api.listAudiobook();
      if (res?.success && Array.isArray(res.data) && res.data.length > 0) {
        this.xttsVoiceOptions.set(res.data);
      }
    } catch {
      /* keep the seeded default options */
    }
  }

  getVoicesForEngine(): { value: string; label: string }[] {
    return this.ttsEngine() === 'orpheus'
      ? this.orpheusVoices()
      : this.xttsVoiceOptions();
  }

  /** Open Settings → XTTS (voices) to download more narration voices. */
  goToVoiceDownloads(): void {
    void this.router.navigate(['/settings'], { queryParams: { section: 'xtts' } });
  }

  /** Open Settings → Voice Enhancement to download more RVC enhancement voices. */
  goToEnhancementDownloads(): void {
    void this.router.navigate(['/settings'], { queryParams: { section: 'enhancement' } });
  }

  /**
   * Scan for partial TTS sessions in the project's stages/03-tts/sessions/.
   */
  private async scanForPartialTtsSessions(): Promise<void> {
    const electron = window.electron as any;
    // Don't drop the user out of an active Continue while re-scanning (e.g. Back from
    // Assembly re-lands on TTS and re-scans) — only the New/Continue toggle resets it.
    if (!this.continueMode()) this.continueTts.set(false);
    this.partialTtsSessions.set([]);

    if (!electron?.sessionCache?.scanProject) return;
    const projectDir = this.projectDir();
    if (!projectDir) return;

    try {
      const result = await electron.sessionCache.scanProject(projectDir);
      if (result.success && result.sessions?.length) {
        // Filter for partial sessions only (not 100% complete)
        // We need to check each session — scanProject returns sentenceCount (files on disk)
        // but we need totalSentences from session-state.json to know if it's partial
        const partials: { language: string; completedSentences: number; totalSentences: number; sessionDir: string; sentencesDir: string }[] = [];
        for (const session of result.sessions) {
          // Use checkResumeFromDir to get total and completed counts
          if (electron?.parallelTts?.checkResumeFromDir) {
            try {
              // sessionDir from scanProject is the ebook-{uuid} dir — find processDir inside it
              const resumeResult = await electron.parallelTts.checkResumeFromDir(session.sessionDir);
              if (resumeResult.success && resumeResult.data?.success) {
                const data = resumeResult.data;
                if (data.completedSentences > 0 && !data.complete) {
                  partials.push({
                    language: session.language,
                    completedSentences: data.completedSentences,
                    totalSentences: data.totalSentences,
                    sessionDir: session.sessionDir,
                    sentencesDir: session.sentencesDir,
                  });
                }
              }
            } catch (err) {
              console.error(`[LL-WIZARD] Error checking session for ${session.language}:`, err);
            }
          }
        }
        this.partialTtsSessions.set(partials);
      }
    } catch (err) {
      console.error('[LL-WIZARD] Error scanning for partial TTS sessions:', err);
    }
  }

  /**
   * Enter "Continue" mode: land on the TTS step with Cleanup + Translate disabled and
   * every TTS control pre-filled with the settings the interrupted run actually used
   * (engine, voice, speed, sampling, device, RVC-enhancement). The user resumes with
   * the same voice by default but is free to change anything before continuing.
   */
  async enterContinueMode(): Promise<void> {
    await this.scanForPartialTtsSessions();
    const partials = this.partialTtsSessions();
    if (!partials.length) {
      console.warn('[LL-WIZARD] enterContinueMode: no partial sessions to continue');
      return;
    }
    await this.prefillFromPartials(partials);
    this.continueTts.set(true);
    this.continueMode.set(true);
    this.passes.set([]);
    this._skippedSteps.add('passes');
    this._skippedSteps.add('cleanup');
    this._skippedSteps.add('translate');
    this.currentStep.set('tts');
  }

  /**
   * Stand on the TTS step, because the book has been handed over to be narrated.
   *
   * The pass step is SKIPPED rather than answered, and that is the honest word
   * for it: the picker's ladder is where this book's passes were composed and
   * run, so the wizard's pass page has nothing left to ask. `skipStep` is the
   * wizard's own mover — it settles the skip marks and enters TTS through
   * `advanceFrom`, which re-scans the project's EPUBs and its partial sessions —
   * so nothing here reimplements the step change.
   *
   * From past narration, `goBack` walks one rung at a time for the same reason.
   * That case is rare (the Process tab destroys this component when the user
   * leaves it, so a fresh arrival is always on the pass step) but it is real:
   * the picker is a separate window, and Next can be pressed while the wizard
   * sits on Review. The equality check makes the walk terminate on a Back that
   * refuses instead of spinning.
   */
  landOnNarration(): void {
    if (this.currentStep() === 'passes') {
      this.skipStep();
      return;
    }
    while (this.currentStep() !== 'tts') {
      const before = this.currentStep();
      this.goBack();
      if (this.currentStep() === before) return;
    }
  }

  /** In-wizard TTS-page "Continue" toggle: same pre-fill + disable behavior, but the
   *  user is already on the TTS step so we don't move them. */
  async activateContinue(): Promise<void> {
    if (!this.partialTtsSessions().length) return;
    await this.prefillFromPartials(this.partialTtsSessions());
    this.continueTts.set(true);
    this.continueMode.set(true);
    this.passes.set([]);
    this._skippedSteps.add('passes');
    this._skippedSteps.add('cleanup');
    this._skippedSteps.add('translate');
  }

  /** "New" toggle: leave Continue mode; settings stay as-is (still editable). */
  setNewMode(): void {
    this.continueTts.set(false);
    this.continueMode.set(false);
  }

  /**
   * Read each partial session's original render settings (persisted in
   * session_state.json, surfaced via checkResumeFromDir → renderSettings) and apply
   * them to the TTS controls: shared engine/sampling/device/speed from the first
   * session, per-language voice onto each TTS row.
   */
  private async prefillFromPartials(
    partials: { language: string; sessionDir: string }[]
  ): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.parallelTts?.checkResumeFromDir) return;

    const voiceByLang = new Map<string, string>();
    let appliedShared = false;
    for (const p of partials) {
      try {
        const res = await electron.parallelTts.checkResumeFromDir(p.sessionDir);
        const rs = res?.data?.renderSettings;
        if (!rs) continue;
        if (rs.fineTuned) voiceByLang.set(p.language, rs.fineTuned);
        if (!appliedShared) {
          this.applySharedRenderSettings(rs, res?.data?.rvcEnhancement);
          appliedShared = true;
        }
      } catch (err) {
        console.error(`[LL-WIZARD] prefill: failed to read settings for ${p.language}:`, err);
      }
    }

    // Per-language voice for the multi-language (bilingual/LL) TTS rows.
    if (voiceByLang.size) {
      this.ttsLanguageRows.update(rows =>
        rows.map(row => {
          const voice = voiceByLang.get(row.language);
          return voice ? { ...row, voice } : row;
        })
      );
    }
  }

  /** Apply engine + voice + sampling + device + RVC-enhancement from a previous run
   *  onto the shared TTS controls. selectTtsEngine() resets the voice to the engine
   *  default, so the voice is set AFTER it. Every field remains user-editable. */
  private applySharedRenderSettings(
    rs: {
      ttsEngine?: string; fineTuned?: string; device?: string; speed?: number;
      temperature?: number; topP?: number; repetitionPenalty?: number;
    },
    rvc?: { enabled?: boolean; voiceId?: string }
  ): void {
    if (rs.ttsEngine) this.selectTtsEngine(rs.ttsEngine as TTSEngine);
    if (rs.fineTuned) this.monoTtsVoice.set(rs.fineTuned);
    if (rs.device) this.ttsDevice.set(rs.device as 'auto' | 'cpu' | 'mps' | 'gpu');
    if (rs.speed !== undefined) this.monoTtsSpeed.set(rs.speed);
    if (rs.temperature !== undefined) this.ttsTemperature.set(rs.temperature);
    if (rs.topP !== undefined) this.ttsTopP.set(rs.topP);
    if (rs.repetitionPenalty !== undefined) this.ttsRepetitionPenalty.set(rs.repetitionPenalty);
    if (rvc?.enabled && rvc.voiceId) {
      this.rvcEnhanceEnabled.set(true);
      this.rvcEnhanceVoiceId.set(rvc.voiceId);
    }
  }

  addTtsRow(): void {
    const defaultVoice = this.ttsEngine() === 'orpheus' ? 'leah' : 'ScarlettJohansson';
    const existingLangs = new Set(this.ttsLanguageRows().map(r => r.language));
    const availableLangs = this.availableTtsLanguages();

    // Remove TTS from skipped steps since we're configuring it
    this._skippedSteps.delete('tts');

    // Find a language that's not already added from available languages
    let newLang = this.detectedSourceLang();
    for (const lang of availableLangs) {
      if (!existingLangs.has(lang.code)) {
        newLang = lang.code;
        break;
      }
    }

    this.ttsLanguageRows.update(rows => [...rows, {
      id: `tts-${Date.now()}-${newLang}`,
      language: newLang,
      voice: defaultVoice,
      speed: newLang === this.detectedSourceLang() ? 1.0 : 0.85
    }]);
  }

  removeTtsRow(index: number): void {
    this.ttsLanguageRows.update(rows => rows.filter((_, i) => i !== index));
  }

  updateTtsRow(index: number, field: keyof TtsLanguageRow, value: any): void {
    this.ttsLanguageRows.update(rows =>
      rows.map((row, i) => {
        if (i !== index) return row;
        // Simple update - EPUB resolution happens at runtime
        return { ...row, [field]: value };
      })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Assembly
  // ─────────────────────────────────────────────────────────────────────────

  setAssemblySourceLang(lang: string): void {
    this.assemblySourceLang.set(lang);
    // If we have both source and target configured, remove from skipped steps
    if (lang && this.assemblyTargetLang()) {
      this._skippedSteps.delete('assembly');
    }
  }

  setAssemblyTargetLang(lang: string): void {
    this.assemblyTargetLang.set(lang);
    // If we have both source and target configured, remove from skipped steps
    if (lang && this.assemblySourceLang()) {
      this._skippedSteps.delete('assembly');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pass builder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Standard vs language learning. The switch is `translateMode`, which is what
   * drives `pipelineMode` and therefore which jobs the submission builds — the
   * two products submit different job sets and always have.
   */
  selectRunType(type: 'standard' | 'language-learning'): void {
    if (type === 'language-learning') {
      this.translateMode.set('sentence');
      return;
    }
    this.translateMode.set(null);
    // The sentence-aligned sub-stages are not part of a standard run, and the
    // bilingual job builders read these flags directly.
    this._skippedSteps.add('cleanup');
    this._skippedSteps.add('translate');
  }

  /**
   * Point the run at a different file.
   *
   * Switching away from a PDF DROPS the scan passes rather than carrying them:
   * they read a PDF's run directory, and the planner would otherwise be handed an
   * EPUB as the document to scan — which it would accept, because it has no way to
   * know the caller meant something else.
   *
   * Switching TO a PDF keeps footnote removal — it is a stage of the scan chain
   * there — but drops its options, which belong to the EPUB reading of a book.
   * The planner refuses a run that still carries them; clearing them here means
   * the user never has to be told.
   */
  selectVariant(card: PassVariantCard): void {
    if (card.disabledReason) return;
    this.selectedVariantId.set(card.id);
    void this.measureSelectedTextLayer(card);
    if (card.format.toLowerCase() !== 'pdf') {
      this.passes.update(list => list.filter(p => !SCAN_ONLY_PASS_KINDS.has(p.kind)));
    } else {
      this.passes.update(list => list.map(
        p => (p.kind === 'footnotes' && p.footnotes ? { uid: p.uid, kind: p.kind } : p)));
    }
    this.palettePanel.set(null);
  }

  /**
   * Ask main whether this PDF has any text of its own, and act on the answer.
   *
   * A PDF with no text CANNOT be narrated without the OCR unit, so the unit is
   * added here and the row refuses to be removed. A failed check is shown, never
   * absorbed: "we could not tell" and "it is optional" are different answers, and
   * only one of them is safe to act on.
   */
  private async measureSelectedTextLayer(card: PassVariantCard): Promise<void> {
    this.textLayerError.set(null);
    if (card.format.toLowerCase() !== 'pdf') {
      this.textLayer.set(null);
      return;
    }
    // An answer about the previous PDF is not an answer about this one.
    if (this.textLayer()?.path !== card.absPath) this.textLayer.set(null);

    this.measuringTextLayer.set(true);
    try {
      const result = await this.electronService.measureTextLayer(card.absPath);
      // The user moved on while mupdf was reading; this answer is about a run
      // that is gone.
      if (this.selectedVariant()?.absPath !== card.absPath) return;
      if (!result.success || !result.data) {
        this.textLayerError.set(
          result.error
            ? `Could not tell whether this PDF has any text of its own: ${result.error}`
            : 'Could not tell whether this PDF has any text of its own, and no reason came back.'
        );
        return;
      }
      this.textLayer.set({ path: card.absPath, report: result.data });
      if (!result.data.hasTextLayer) this.ensureOcrPass();
    } catch (err) {
      if (this.selectedVariant()?.absPath !== card.absPath) return;
      this.textLayerError.set(
        `Could not tell whether this PDF has any text of its own: ${(err as Error).message}`
      );
    } finally {
      this.measuringTextLayer.set(false);
    }
  }

  /**
   * Get Text, added if the run has none. First in the order — nothing downstream
   * has a document to read until it has run.
   */
  private ensureOcrPass(): void {
    if (this.passes().some(p => p.kind === 'get-text')) return;
    this.passes.update(list => [
      { uid: this.nextPassUid(), kind: 'get-text' as ProcessingPassKind },
      ...list,
    ]);
  }

  /** True when this row is Get Text and this PDF cannot be read without it. */
  passLocked(pass: BuilderPass): boolean {
    return pass.kind === 'get-text' && this.ocrRequiredReason() !== null;
  }

  onPaletteClick(kind: ProcessingPassKind): void {
    if (kind === 'simplify' || kind === 'translate') {
      this.palettePanel.set(this.palettePanel() === kind ? null : kind);
      return;
    }
    // Footnote removal has one option, and it exists only when the pass reads the
    // book EPUB. On a PDF the pass rewrites the working document's text layer and
    // has nothing to set, so it is added on the click like the document passes.
    if (kind === 'footnotes' && !this.selectedIsPdf()) {
      this.palettePanel.set(this.palettePanel() === kind ? null : kind);
      return;
    }
    this.addPass({ uid: this.nextPassUid(), kind });
  }

  addFootnotesPass(): void {
    const askEverything = this.passFootnotesAskEverything();
    this.addPass({
      uid: this.nextPassUid(),
      kind: 'footnotes',
      ...(askEverything ? { footnotes: { askEverything: true } } : {}),
    });
    this.palettePanel.set(null);
    this.passFootnotesAskEverything.set(false);
  }

  addSimplifyPass(mode: 'dejargon' | 'destiffen' | 'learner'): void {
    // Snapshotted, not referenced: two Simplify passes in one run are legal and
    // may want different models, so each carries the settings it was added with.
    this.addPass({
      uid: this.nextPassUid(),
      kind: 'simplify',
      simplify: {
        mode,
        aiProvider: this.cleanupProvider(),
        aiModel: this.cleanupModel(),
        customInstructions: this.customInstructions() || undefined,
      },
    });
    this.palettePanel.set(null);
  }

  addTranslatePass(): void {
    this.addPass({
      uid: this.nextPassUid(),
      kind: 'translate',
      translate: {
        sourceLang: this.passTranslateSource(),
        targetLang: this.passTranslateTarget(),
        aiProvider: this.translateProvider(),
        aiModel: this.translateModel(),
        customInstructions: this.translateCustomInstructions() || undefined,
      },
    });
    this.palettePanel.set(null);
  }

  private addPass(pass: BuilderPass): void {
    this.passes.update(list => [...list, pass]);
  }

  private nextPassUid(): string {
    this.passUid += 1;
    return `pass-${this.passUid}`;
  }

  movePass(index: number, delta: number): void {
    this.passes.update(list => {
      const to = index + delta;
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  removePass(index: number): void {
    // The button is disabled, but the guard is here too: this is the rule, and a
    // rule that lives only in a `[disabled]` binding is one keyboard event away
    // from a run that narrates an empty book.
    const pass = this.passes()[index];
    if (pass && this.passLocked(pass)) return;
    this.passes.update(list => list.filter((_, i) => i !== index));
  }

  passLabel(pass: BuilderPass): string {
    return PASS_LABELS[pass.kind];
  }

  passDetail(pass: BuilderPass): string {
    if (pass.kind === 'get-text') {
      // Said on the row because it is what the pass DOES, not an option: the cast
      // REPLACES the working document, so the pages are read again from the
      // archive original and whatever was in it before is gone.
      return 'Reads every page again and casts the working PDF fresh';
    }
    if (pass.kind === 'blocks') {
      return 'Labels every block into the working PDF as annotations';
    }
    if (pass.kind === 'reflow') {
      return 'Drops what you deleted, repairs the OCR of what you kept, writes the book';
    }
    if (pass.kind === 'footnotes') {
      if (this.selectedIsPdf()) {
        // Which document the pass reads is POSITIONAL, mirroring the planner's
        // footnotesModeAt: before a later Build the book it edits the text layer
        // that reflow will read; after one it reads the book that reflow wrote.
        const list = this.passes();
        const index = list.findIndex(p => p.uid === pass.uid);
        const laterReflow = list.some((p, i) => p.kind === 'reflow' && i > index);
        const earlierReflow = list.some((p, i) => p.kind === 'reflow' && i < index);
        if (!laterReflow && (earlierReflow || this.bookEpubPath())) {
          return 'On the finished book';
        }
        return "On the working PDF's text layer";
      }
      return pass.footnotes?.askEverything
        ? 'Note bodies and index entries too'
        : 'Note bodies and index entries left alone';
    }
    if (pass.simplify) {
      const mode = this.simplifyModeOptions.find(m => m.value === pass.simplify!.mode);
      return `${mode?.label ?? pass.simplify.mode} · ${pass.simplify.aiModel || 'no model'}`;
    }
    if (pass.translate) {
      const t = pass.translate;
      return `${this.getLanguageName(t.sourceLang)} → ${this.getLanguageName(t.targetLang)} · ${t.aiModel || 'no model'}`;
    }
    return '';
  }

  /**
   * The project's files, as the metadata page lists them, plus its book EPUB.
   *
   * An ebook variant that is NOT the recorded book is listed but closed: the text
   * passes rewrite `outputs.epub` in place, so offering another edition as their
   * input would promise something the run does not do.
   */
  private async loadVariantCards(): Promise<void> {
    const projectDir = this.effectiveProjectDir();
    // `variant:list` resolves {library}/projects/<id>/manifest.json, so it needs the
    // FOLDER SLUG. What arrives in `projectId` is not always one: Studio binds a
    // book's `StudioItem.id`, which is its absolute project directory (articles
    // bind a bare manifest id) — the same split `studioManifestProjectId` exists
    // for, and taking the last segment is the identity for a value that is already
    // an id. Without this the join produced /…/projects/Volumes/…/manifest.json,
    // no variants came back, and page 1 declared a project with a PDF to have
    // nothing to process.
    const projectId = (this.projectId() || projectDir).split(/[\\/]/).filter(Boolean).pop() || '';
    if (!projectId) {
      this.variantCards.set([]);
      this.bookEpubPath.set(null);
      return;
    }

    this.loadingVariants.set(true);
    try {
      let bookAbs: string | null = null;
      try {
        const info = await this.electronService.projectsExportInfo(projectDir);
        bookAbs = info.exported?.absPath ?? null;
      } catch (err) {
        console.warn('[LL-WIZARD] Could not resolve the project export:', (err as Error).message);
      }
      this.bookEpubPath.set(bookAbs);

      const cards: PassVariantCard[] = [];
      const result = await this.electronService.variantList(projectId);
      for (const v of result.variants ?? []) {
        if (v.kind !== 'ebook' || !v.exists) continue;
        const format = (v.format || '').toLowerCase();
        const isBook = !!bookAbs && this.samePath(v.absPath, bookAbs);
        cards.push({
          id: isBook ? '' : v.id,
          label: v.descriptor || v.metadata?.title || this.title() || 'Untitled edition',
          format,
          filename: this.getFilenameFromPath(v.absPath),
          absPath: v.absPath,
          disabledReason: (format === 'pdf' || isBook)
            ? ''
            : 'The text passes rewrite the project\'s own book EPUB, not this edition.',
        });
      }
      if (bookAbs && !cards.some(c => c.id === '')) {
        cards.push({
          id: '',
          label: 'Book EPUB',
          format: 'epub',
          filename: this.getFilenameFromPath(bookAbs),
          absPath: bookAbs,
          disabledReason: '',
        });
      }
      this.variantCards.set(cards);

      // Keep the selection on something real. The book EPUB is the usual subject
      // of a run; a project that has none is a scan waiting for its first pass.
      const current = cards.find(c => c.id === this.selectedVariantId() && !c.disabledReason);
      if (!current) {
        const book = cards.find(c => c.id === '' && !c.disabledReason);
        const first = book ?? cards.find(c => !c.disabledReason);
        this.selectedVariantId.set(first ? first.id : '');
      }

      // A PDF that arrives selected has to be measured too, not just one the user
      // clicks: a project whose only file is a scan opens on that scan, and the
      // OCR unit it cannot run without is added from the answer.
      const selected = cards.find(c => c.id === this.selectedVariantId());
      if (selected) void this.measureSelectedTextLayer(selected);
    } finally {
      this.loadingVariants.set(false);
    }
  }

  /** Path equality for display/selection only — never to build a path. */
  private samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return norm(a) === norm(b);
  }

  /**
   * The run as the planner wants it. API keys and the Ollama URL are filled in
   * here, at the last moment, so no secret is ever held in the sidebar's state.
   */
  /**
   * The run as the planner wants it: ONE request pass per sidebar row.
   *
   * "OCR correction" is one row, one pass, one queue job — reading the pages,
   * repairing what was read and labelling the blocks are three foundry stages of
   * it, and the queue draws a bar for each. The row used to be expanded into a
   * `tesseract` pass and an `ocr-correction` pass here; nothing was gained by the
   * user seeing two rows for one thing they cannot order, choose between, or run
   * halves of, and the planner refuses a `tesseract` pass now.
   *
   * A pass in a submitted run ALWAYS re-runs its own stages, and there is no
   * option about it: OCR correction starts the run directory over, so the pages
   * are rasterized again and the scan, repair and layout models all run. The
   * checkbox that used to ask ("Re-scan from the page images", default OFF) is
   * gone — a run that quietly handed back this morning's artifacts answered a
   * question nobody asked, instantly, and looked like success while doing it.
   * The scan is therefore always part of the pass rather than conditionally
   * included, and for the same reason: what is on disk is not this run.
   */
  private chainRequest(projectDir: string, variantId: string, list: BuilderPass[]): ProcessingChainRequest {
    const ai = this.settingsService.getAIConfig();
    const withCredentials = <T extends SimplifyPassParams | TranslatePassParams>(params: T): T => ({
      ...params,
      ollamaBaseUrl: ai.ollama?.baseUrl,
      claudeApiKey: ai.claude?.apiKey,
      openaiApiKey: ai.openai?.apiKey,
    });
    const passes: ChainPassRequest[] = list.map(p => ({
      kind: p.kind,
      ...(p.footnotes ? { footnotes: p.footnotes } : {}),
      ...(p.simplify ? { simplify: withCredentials(p.simplify) } : {}),
      ...(p.translate ? { translate: withCredentials(p.translate) } : {}),
    }));
    return {
      projectDir,
      ...(variantId ? { variantId } : {}),
      passes,
    };
  }

  /** Ask main what this order would do. The answer is the sidebar's feedback. */
  private async replanChain(projectDir: string, variantId: string, list: BuilderPass[]): Promise<void> {
    try {
      const result = await this.electronService.planProcessingChain(
        this.chainRequest(projectDir, variantId, list));
      // A later edit already re-planned; this answer is about a run that is gone.
      if (this.passes() !== list) return;
      if (result.success && result.plan) {
        this.chainPlan.set(result.plan);
        this.chainError.set(null);
      } else {
        this.chainPlan.set(null);
        this.chainError.set(result.error || 'This run could not be planned, and no reason came back.');
      }
    } catch (err) {
      this.chainPlan.set(null);
      this.chainError.set((err as Error).message);
    } finally {
      this.planning.set(false);
    }
  }

  /** True when this run renders narration (as opposed to reusing a cached one). */
  ttsInThisRun(): boolean {
    if (this._skippedSteps.has('tts')) return false;
    if (this.pipelineMode() === 'bilingual') return this.ttsLanguageRows().length > 0;
    return !this.ttsBlockedReason();
  }

  /**
   * Why assembly cannot run, or null. Reads `_skippedSteps`, which is not a
   * signal, so it stays a method — the template re-asks it every check.
   */
  assemblyBlockedReason(): string | null {
    if (this.ttsInThisRun()) return null;
    if (this.availableSessions().length > 0 || this.cachedSession()) return null;
    return 'There is nothing to assemble: this book has no cached narration, and this run renders none.';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  isStepCompleted(step: LLWizardStep): boolean {
    return this.completedSteps.has(step);
  }

  isStepSkipped(step: LLWizardStep): boolean {
    return this._skippedSteps.has(step);
  }

  hasStageData(step: string): boolean {
    return this.stagesWithData().has(step);
  }

  toggleAiCleanup(): void {
    if (!this.enableAiCleanup()) {
      this.enableAiCleanup.set(true);
      // Remove cleanup from skipped steps since we're configuring it
      this._skippedSteps.delete('cleanup');
      // The cleanup step shares one AI selector; honor the cleanup default.
      const d = this.settingsService.getPipelineDefaults();
      this.cleanupProvider.set(d.cleanupProvider);
      this.cleanupModel.set(d.cleanupModel);
    } else {
      this.enableAiCleanup.set(false);
    }
  }

  /** User-driven stage pick. Latches so provenance stops re-deciding for them. */
  selectCleanupStages(v: CleanupStages): void {
    this.cleanupStagesTouched = true;
    this.cleanupStages.set(v);
  }

  phaseLabel(phase: string): string {
    switch (phase) {
      case 'resolve': return 'Preparing…';
      case 'download': return 'Downloading…';
      case 'verify': return 'Verifying download…';
      case 'extract': return 'Extracting…';
      case 'postinstall': return 'Finishing install…';
      case 'verify-run': return 'Verifying install…';
      case 'done': return 'Done';
      case 'error': return 'Failed';
      default: return phase;
    }
  }

  /**
   * Seed the stage picker from the project's import provenance: a scanned PDF gets
   * 'both', anything born digital gets 'tts' (there is no scanner damage to repair).
   * Runs whenever the selected project changes, and stops as soon as the user picks.
   *
   * Deliberately keyed on manifest.source.type and NOT on the chosen source EPUB —
   * that is always exported.epub, which looks identical whether it was typeset or
   * scraped off a scan.
   */
  private syncCleanupStagesDefault(): void {
    if (this.cleanupStagesTouched) return;
    const src = this.sourceType();
    if (!src) {
      // No provenance reached us (no project selected yet, or a manifest missing
      // source.type). Don't guess a costly model pass — default to the cheap pass
      // and leave the picker visible. Loud in the console so a manifest that really
      // is missing the field gets noticed rather than silently defaulting forever.
      console.warn('[LL-WIZARD] No source type for this project — defaulting to TTS cleaning only; pick OCR repair manually if this book was scanned');
      this.cleanupStages.set('tts');
      return;
    }
    this.cleanupStages.set(src === 'pdf' ? 'both' : 'tts');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI Prompt Editor (edits the global cleanup prompt file)
  // ─────────────────────────────────────────────────────────────────────────

  async togglePromptAccordion(): Promise<void> {
    const opening = !this.promptAccordionOpen();
    this.promptAccordionOpen.set(opening);
    if (opening && !this.promptText() && !this.loadingPrompt()) {
      await this.loadPrompt();
    }
  }

  async loadPrompt(): Promise<void> {
    this.loadingPrompt.set(true);
    try {
      const result = await this.electronService.getAIPrompt();
      if (result) {
        this.promptText.set(result.prompt);
        this.originalPromptText.set(result.prompt);
      }
    } catch (err) {
      console.error('Failed to load prompt:', err);
    } finally {
      this.loadingPrompt.set(false);
    }
  }

  onPromptChange(event: Event): void {
    this.promptText.set((event.target as HTMLTextAreaElement).value);
  }

  async savePrompt(): Promise<void> {
    this.savingPrompt.set(true);
    try {
      const success = await this.electronService.saveAIPrompt(this.promptText());
      if (success) {
        this.originalPromptText.set(this.promptText());
      }
    } catch (err) {
      console.error('Failed to save prompt:', err);
    } finally {
      this.savingPrompt.set(false);
    }
  }

  toggleSimplify(): void {
    if (!this.simplifyForLearning()) {
      this.simplifyForLearning.set(true);
      // Remove cleanup from skipped steps since we're configuring it
      this._skippedSteps.delete('cleanup');
      // Simplify-only intent → use the simplify AI default (the step shares one
      // selector with cleanup, so only apply when cleanup isn't also on).
      if (!this.enableAiCleanup()) {
        const d = this.settingsService.getPipelineDefaults();
        this.cleanupProvider.set(d.simplifyProvider);
        this.cleanupModel.set(d.simplifyModel);
      }
    } else {
      this.simplifyForLearning.set(false);
    }
  }

  canProceed(): boolean {
    const step = this.currentStep();
    if (step === 'passes') {
      if (this.pipelineMode() === 'mono') {
        if (this.passes().length === 0) return true;  // narration-only run
        // An order main has refused cannot be submitted, and saying so at the
        // Next button (as well as on the row) is the whole point of pre-planning.
        return !this.chainError() && !this.planning();
      }
      // Sentence-aligned: the cleanup and translation gates that used to guard two
      // separate steps, now both on this page.
      if (this.enableAiCleanup() || this.simplifyForLearning()) {
        if (this.cleanupProvider() === 'ollama' && !this.ollamaConnected()) return false;
        if (!this.cleanupModel()) return false;
      }
      if (this.targetLangs().size > 0) {
        if (this.translateProvider() === 'ollama' && !this.ollamaConnected()) return false;
        if (!this.translateModel()) return false;
      }
      return true;
    }
    if (step === 'tts') {
      if (this.pipelineMode() === 'mono') return true; // single voice always configured
      return this.ttsLanguageRows().length > 0;
    }
    if (step === 'assembly') {
      return true; // Always can proceed, will skip if no langs selected
    }
    return true;
  }

  /**
   * Whether a step is currently configured to do real work. When the user hits
   * "Next", this decides whether the step shows as active or as skipped — so the
   * indicator reflects what they just chose, not an earlier decision.
   */
  private isStepConfigured(step: LLWizardStep): boolean {
    switch (step) {
      case 'passes':
        return this.pipelineMode() === 'mono'
          ? this.passes().length > 0
          : (this.enableAiCleanup() || this.simplifyForLearning() || this.targetLangs().size > 0);
      case 'tts':
        if (this.ttsBlockedReason()) return false;
        return this.pipelineMode() === 'mono' || this.ttsLanguageRows().length > 0;
      case 'assembly':
        if (this.assemblyBlockedReason()) return false;
        return this.pipelineMode() === 'mono'
          || !!(this.assemblySourceLang() && this.assemblyTargetLang());
      default:
        return true;
    }
  }

  skipStep(): void {
    const step = this.currentStep();
    // Explicit skip: mark skipped and clear any prior "completed" state so the
    // downstream reconciliation (e.g. entering Review) can't silently un-skip it.
    this._skippedSteps.add(step);
    this.completedSteps.delete(step);
    if (step === 'passes') {
      this._skippedSteps.add('cleanup');
      this._skippedSteps.add('translate');
    }
    void this.advanceFrom(step);
  }

  async goNext(): Promise<void> {
    const step = this.currentStep();
    // Reconcile the step being LEFT against the user's current choice: if it's
    // configured it's active (un-skip); if they left it empty it's effectively
    // skipped. This is what makes the indicator reflect what they just chose
    // rather than what they chose previously.
    if (this.isStepConfigured(step)) {
      this._skippedSteps.delete(step);
      this.completedSteps.add(step);
    } else {
      this._skippedSteps.add(step);
      this.completedSteps.delete(step);
    }
    // The sentence-aligned pipeline submits a cleanup job and per-language
    // translation jobs separately, so leaving page 1 settles each on its own.
    if (step === 'passes') this.reconcileTextSubStages();
    await this.advanceFrom(step);
  }

  /**
   * Advance from the given step to the next one, reconciling downstream steps'
   * skip state as they are entered. Shared by Skip and Next so navigation
   * behaves identically regardless of how the current step's state was resolved.
   */
  /**
   * Settle the sentence-aligned sub-stages from what page 1 currently says.
   *
   * 'cleanup' and 'translate' stopped being pages, but the bilingual job builder
   * still asks, separately, whether each is part of the run — so the answer is
   * derived here rather than left at whatever an earlier visit set.
   */
  private reconcileTextSubStages(): void {
    const bilingual = this.pipelineMode() === 'bilingual';
    const cleanupOn = bilingual && (this.enableAiCleanup() || this.simplifyForLearning());
    const translateOn = bilingual && this.targetLangs().size > 0;
    if (cleanupOn) this._skippedSteps.delete('cleanup'); else this._skippedSteps.add('cleanup');
    if (translateOn) this._skippedSteps.delete('translate'); else this._skippedSteps.add('translate');
  }

  private async advanceFrom(step: LLWizardStep): Promise<void> {
    const stepOrder: LLWizardStep[] = ['passes', 'tts', 'assembly', 'review'];
    const currentIndex = stepOrder.indexOf(step);
    if (currentIndex < stepOrder.length - 1) {
      const nextStep = stepOrder[currentIndex + 1];

      // Check if TTS is configured when entering the step
      if (nextStep === 'tts') {
        // Re-scan for EPUBs to pick up newly created language files from Translation
        // IMPORTANT: Must await to ensure scan completes before TTS configuration
        await this.scanProjectEpubs();
        // Scan for partial TTS sessions (for Continue button)
        this.scanForPartialTtsSessions();

        if (this.pipelineMode() === 'mono' || this.ttsLanguageRows().length > 0) {
          // TTS is configured, remove from skipped
          this._skippedSteps.delete('tts');
        }
      }

      // Check if assembly is configured when entering the step
      if (nextStep === 'assembly') {
        if (this.pipelineMode() === 'mono') {
          if (!this.assemblyBlockedReason()) {
            this._skippedSteps.delete('assembly');
          }
        } else if (this.assemblySourceLang() && this.assemblyTargetLang()) {
          // Assembly has both languages configured, remove from skipped
          this._skippedSteps.delete('assembly');
        }
        // Rescan sessions when entering assembly step
        this.scanAvailableSessions();
      }

      // When entering review, un-skip steps that were auto-skipped but now have config.
      // Only un-skip if the user didn't explicitly skip the step (completedSteps tracks
      // steps the user passed through without skipping).
      if (nextStep === 'review') {
        // Check TTS — don't un-skip if user explicitly skipped it
        if ((this.pipelineMode() === 'mono' || this.ttsLanguageRows().length > 0) && this.completedSteps.has('tts')) {
          this._skippedSteps.delete('tts');
        }
        // Check assembly
        const assemblyConfigured = !this.assemblyBlockedReason()
          && (this.pipelineMode() === 'mono'
            || !!(this.assemblySourceLang() && this.assemblyTargetLang()));
        if (assemblyConfigured && this.completedSteps.has('assembly')) {
          this._skippedSteps.delete('assembly');
        }
      }

      // Auto-skip assembly if it has nothing to work with
      if (step === 'assembly') {
        if (this.pipelineMode() === 'mono') {
          if (this.assemblyBlockedReason()) {
            this._skippedSteps.add('assembly');
          }
        } else if (!this.assemblySourceLang() || !this.assemblyTargetLang()) {
          this._skippedSteps.add('assembly');
        }
      }

      this.currentStep.set(nextStep);
    }
  }

  goBack(): void {
    const stepOrder: LLWizardStep[] = ['passes', 'tts', 'assembly', 'review'];
    let idx = stepOrder.indexOf(this.currentStep()) - 1;
    // In Continue mode, Cleanup + Translate are disabled (nothing to re-run) — walk
    // past them so Back never drops the user into a disabled step. From TTS this
    // makes Back a no-op, keeping the flow pinned to TTS→Assembly→Review.
    if (this.continueMode()) {
      while (idx >= 0 && this._skippedSteps.has(stepOrder[idx])) idx--;
    }
    if (idx < 0) return;
    const prevStep = stepOrder[idx];
    this.currentStep.set(prevStep);
    if (prevStep === 'tts') {
      this.scanForPartialTtsSessions();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Review Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getTotalJobCount(): number {
    if (this.pipelineMode() === 'mono') {
      // One queue row per pass, plus narration and assembly. The workflow's own
      // master row is not counted — it is the grouping, not a job.
      let count = this.passes().length;
      const hasTts = this.ttsInThisRun();
      if (hasTts) count += 1;
      const hasAssembly = !this._skippedSteps.has('assembly') && !this.assemblyBlockedReason();
      if (hasAssembly) count += 1;
      if (hasAssembly && this.generateVideo()) count += 1;
      return count;
    }

    let count = 0;

    // Cleanup + Simplify jobs (independent, can both be enabled)
    if (!this._skippedSteps.has('cleanup')) {
      if (this.enableAiCleanup()) count += 1;
      if (this.simplifyForLearning()) count += 1;
    }

    // Translation jobs (one per language)
    if (!this._skippedSteps.has('translate') && this.targetLangs().size > 0) {
      count += this.targetLangs().size;
    }

    // TTS jobs (one per row)
    if (!this._skippedSteps.has('tts')) {
      count += this.ttsLanguageRows().length;
    }

    // Assembly job
    if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
      count += 1;
    }

    return count;
  }

  getReviewWarnings(): string[] {
    if (this.pipelineMode() === 'mono') {
      const warnings: string[] = [];
      if (this.chainError()) warnings.push(this.chainError()!);
      const blocked = this.assemblyBlockedReason();
      if (!this._skippedSteps.has('assembly') && blocked) warnings.push(blocked);
      return warnings;
    }

    const warnings: string[] = [];

    // Check if TTS references a language that won't exist
    const ttsLangs = new Set(this.ttsLanguageRows().map(r => r.language));
    const translationLangs = this.targetLangs();
    const availableSessionLangs = new Set(this.availableSessions().map(s => s.language));

    for (const lang of ttsLangs) {
      if (lang !== this.detectedSourceLang() &&
          !translationLangs.has(lang) &&
          !availableSessionLangs.has(lang) &&
          !this.availableEpubs().some(e => e.lang === lang)) {
        warnings.push(`TTS row for ${lang.toUpperCase()} has no source EPUB or translation job`);
      }
    }

    // Check assembly references
    if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
      const sourceLang = this.assemblySourceLang();
      const targetLang = this.assemblyTargetLang();

      const hasSourceSession = availableSessionLangs.has(sourceLang) || ttsLangs.has(sourceLang);
      const hasTargetSession = availableSessionLangs.has(targetLang) || ttsLangs.has(targetLang);

      if (!hasSourceSession) {
        warnings.push(`Assembly source (${sourceLang.toUpperCase()}) has no TTS session or job`);
      }
      if (!hasTargetSession) {
        warnings.push(`Assembly target (${targetLang.toUpperCase()}) has no TTS session or job`);
      }
    }

    return warnings;
  }

  getFilenameFromPath(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue Jobs
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pre-flight: if a selected XTTS voice isn't downloaded yet, offer a one-click
   * download before queuing. Declining still proceeds — the voice then downloads
   * on demand when the job runs (with progress in the queue). Voices that aren't
   * downloadable components (the stock voice / voice-library clones, which use
   * the base model) are left to that on-demand path.
   */
  private async ensureSelectedVoicesAvailable(): Promise<void> {
    if (this._skippedSteps.has('tts') || this.ttsEngine() !== 'xtts') return;
    await this.componentService.ensureLoaded();

    const ids = this.pipelineMode() === 'mono'
      ? [this.monoTtsVoice()]
      : this.ttsLanguageRows().map(r => r.voice);

    const statuses = this.componentService.components();
    const missing = [...new Set(ids)]
      .map(id => statuses.find(s => s.component.id === id && s.component.kind === 'tts-model'))
      .filter((s): s is NonNullable<typeof s> => !!s && !this.componentService.isInstalled(s!.component.id));

    if (missing.length === 0) return;

    const names = missing.map(s => s.component.name).join(', ');
    const plural = missing.length > 1;
    const { confirmed } = await this.electronService.showConfirmDialog({
      type: 'question',
      title: plural ? 'Download voices?' : 'Download voice?',
      message: `${names} ${plural ? "aren't" : "isn't"} downloaded yet (~1.7 GB each).`,
      detail: 'Download now, or choose “Queue anyway” to fetch it automatically when the job runs.',
      confirmLabel: 'Download now',
      cancelLabel: 'Queue anyway',
    });
    if (!confirmed) return; // proceed; the on-demand fallback handles it at job time

    for (const s of missing) {
      this.voiceDownloadMsg.set(`Downloading ${s.component.name}…`);
      try {
        await this.componentService.install(s.component.id);
      } catch (err) {
        console.error('[LL-WIZARD] Voice download failed (will retry at job time):', err);
      }
    }
    this.voiceDownloadMsg.set(null);
  }

  async addToQueue(): Promise<void> {
    if (this.getTotalJobCount() === 0) return;
    // Remember the user's TTS picks as the new Pipeline Defaults, so the next job
    // (and the next book) starts from what they last chose — device included.
    this.settingsService.updatePipelineDefaults({
      ttsEngine: this.ttsEngine(),
      ttsDevice: this.ttsDevice(),
      ttsVoice: this.monoTtsVoice(),
      ttsSpeed: this.monoTtsSpeed(),
      // Remember the sampling sliders too — whatever the user set becomes the
      // default next time. "Reset to stock" in the UI puts them back.
      ttsTemperature: this.ttsTemperature(),
      ttsTopP: this.ttsTopP(),
      ttsRepetitionPenalty: this.ttsRepetitionPenalty(),
      // Per-run RVC enhancement choice — the queue reads these from the defaults at
      // job time and adds the post-TTS voice-conversion pass. Only meaningful when
      // a voice is chosen; persist disabled if the user didn't pick one.
      rvcEnhancementEnabled: this.rvcEnhanceEnabled() && !!this.rvcEnhanceVoiceId(),
      rvcEnhancementVoiceId: this.rvcEnhanceVoiceId(),
      rvcEnhancementIndexRate: this.rvcEnhanceIndexRate(),
      rvcEnhancementProtectRate: this.rvcEnhanceProtectRate(),
      rvcEnhancementNSemitones: this.rvcEnhanceNSemitones(),
    });

    const projectDir = this.effectiveProjectDir();
    if (!projectDir) {
      console.error('[LLWizard] No project directory available');
      return;
    }

    await this.ensureSelectedVoicesAvailable();

    if (this.pipelineMode() === 'mono') {
      return this.addMonoJobsToQueue(projectDir);
    }

    this.addingToQueue.set(true);

    // Titles of jobs that actually made it into the queue. If a later addJob
    // throws, the catch below names these and blocks a retry from re-adding
    // them (the Add button re-submits the WHOLE job set).
    const queuedJobTitles: string[] = [];
    const addJobTracked = async (request: Parameters<QueueService['addJob']>[0]) => {
      const job = await this.queueService.addJob(request);
      queuedJobTitles.push(request.metadata?.title || request.type);
      return job;
    };

    try {
      const workflowId = this.generateWorkflowId();
      const aiConfig = this.settingsService.getAIConfig();

      // Pre-flight: the optional video job reads the assembly's output from under the
      // PROJECT directory, so that directory has to be KNOWN. Checked here, before any
      // job is queued, so a missing projectDir fails the whole submission cleanly instead
      // of leaving a half-queued workflow (same reason as the RVC pre-flight in the
      // mono path). Empty would have queued a job pointed at "/output" and failed at
      // run time, with a path nobody can place, long after this click.
      const videoProjectDir = this.projectDir();
      if (this.generateVideo() && !this._skippedSteps.has('assembly') && !videoProjectDir) {
        throw new Error(
          'Cannot queue the video job: this project has no project directory (projectDir), '
          + 'so there is nowhere to read the assembled audiobook from.',
        );
      }

      // Track what the cleanup step will produce (for downstream jobs to reference)
      let cleanupWillProduce: 'cleaned' | 'simplified' | null = null;

      // 1. Cleanup + Simplify jobs (independent, can both be enabled)
      if (!this._skippedSteps.has('cleanup')) {
        const cleanupValue = this.enableAiCleanup();
        const simplifyValue = this.simplifyForLearning();

        // Shared AI config for both jobs
        const baseConfig = {
          type: 'bilingual-cleanup' as const,
          projectId: this.projectId(),
          projectDir: projectDir,
          sourceLang: this.detectedSourceLang(),
          aiProvider: this.cleanupProvider(),
          aiModel: this.cleanupModel(),
          ollamaBaseUrl: aiConfig.ollama?.baseUrl,
          claudeApiKey: aiConfig.claude?.apiKey,
          openaiApiKey: aiConfig.openai?.apiKey,
          cleanupPrompt: undefined as string | undefined, // Backend loads from file
          customInstructions: this.customInstructions() || undefined,
        };

        // Resolve cleanup source from stage picker
        const cleanupSource = this.resolveLatestSource('cleanup');

        // Job 1a: AI Cleanup
        if (cleanupValue) {
          console.log('[LL-WIZARD] Creating AI Cleanup job');
          await addJobTracked({
            type: 'bilingual-cleanup',
            epubPath: cleanupSource,
            projectDir: projectDir,
            metadata: {
              title: 'AI Cleanup',
            },
            config: { ...baseConfig, simplifyForLearning: false },
            workflowId,
          });
          cleanupWillProduce = 'cleaned';
        }

        // Job 1b: Simplify (uses cleaned.epub as input if cleanup also enabled)
        if (simplifyValue) {
          const simplifySource = cleanupValue
            ? `${projectDir}/stages/01-cleanup/cleaned.epub`
            : cleanupSource;
          console.log('[LL-WIZARD] Creating Simplify job, source:', simplifySource);
          await addJobTracked({
            type: 'bilingual-cleanup',
            epubPath: simplifySource,
            projectDir: projectDir,
            metadata: {
              title: 'Simplify for Learning',
            },
            config: { ...baseConfig, simplifyForLearning: true, simplifyMode: this.simplifyMode() },
            workflowId,
          });
          cleanupWillProduce = 'simplified';
        }
      }

      // 2. Translation jobs (if not skipped, one per target language)
      if (!this._skippedSteps.has('translate') && this.targetLangs().size > 0) {
        // If cleanup/simplify is in the pipeline, use the expected output path
        // (the file won't exist yet but will by the time translate runs)
        let translateSource: string;
        if (cleanupWillProduce) {
          translateSource = `${projectDir}/stages/01-cleanup/${cleanupWillProduce}.epub`;
          console.log('[LL-WIZARD] Translate will use expected cleanup output:', translateSource);
        } else {
          translateSource = this.resolveLatestSource('translate');
        }

        for (const targetLang of this.targetLangs()) {
          await addJobTracked({
            type: 'bilingual-translation',
            epubPath: translateSource,
            projectDir: projectDir,
            metadata: {
              title: `Translate → ${this.getLanguageName(targetLang)}`,
            },
            config: {
              type: 'bilingual-translation',
              projectId: this.projectId(),
              projectDir: projectDir,
              sourceLang: this.detectedSourceLang(),
              targetLang,
              aiProvider: this.translateProvider(),
              aiModel: this.translateModel(),
              ollamaBaseUrl: aiConfig.ollama?.baseUrl,
              claudeApiKey: aiConfig.claude?.apiKey,
              openaiApiKey: aiConfig.openai?.apiKey,
              customInstructions: this.translateCustomInstructions() || undefined,
            },
            workflowId,
          });
        }
      }

      // 3. TTS jobs (one per language row, or resume partial sessions)
      if (!this._skippedSteps.has('tts')) {
       // Check if assembly chaining is needed (TTS → Assembly via bilingual workflow pattern)
       const assemblyChained = !this._skippedSteps.has('assembly')
         && !!this.assemblySourceLang() && !!this.assemblyTargetLang();

       if (this.continueTts() && this.partialTtsSessions().length) {
        // Continue mode: resume partial TTS sessions
        console.log(`[LL-WIZARD] Creating TTS resume jobs for ${this.partialTtsSessions().length} partial sessions`);
        const electron = window.electron as any;
        for (const session of this.partialTtsSessions()) {
          const resumeCheck = await electron.parallelTts.checkResumeFromDir(session.sessionDir);
          const resumeData = resumeCheck?.data;
          if (!resumeData?.success) {
            // Abort the whole continue instead of silently skipping this
            // language: the bilingual workflow needs BOTH languages' sessions
            // (assembly pairs them), so a half-queued continue is broken.
            // The catch below surfaces this and names any jobs already queued.
            console.error(`[LL-WIZARD] Failed to get resume info for ${session.language}:`, resumeCheck?.data?.error);
            throw new Error(`Cannot resume the ${session.language.toUpperCase()} TTS session: ${resumeCheck?.data?.error || 'the cached session could not be read'}`);
          }
          if (!resumeData.sourceEpubPath) {
            throw new Error(`Cannot resume the ${session.language.toUpperCase()} TTS session: the cached session is missing its source EPUB path`);
          }

          await addJobTracked({
            type: 'tts-conversion',
            epubPath: resumeData.sourceEpubPath,
            projectDir,
            metadata: { title: `TTS Continue (${session.language.toUpperCase()})`, coverPath: this.coverPath() || undefined },
            config: {
              type: 'tts-conversion',
              language: session.language,
              // Engine/voice/sampling: the wizard's controls (pre-filled from this
              // session's original run, then whatever the user changed). Without these
              // the queue would default to xtts/ScarlettJohansson. The row voice wins;
              // if no row matches this language, use the ORIGINAL persisted voice — never
              // a stock default.
              ttsEngine: this.ttsEngine(),
              fineTuned: this.ttsLanguageRows().find(r => r.language === session.language)?.voice
                || resumeData.renderSettings?.fineTuned,
              device: this.ttsDevice(),
              temperature: this.ttsTemperature(),
              topP: this.ttsTopP(),
              topK: 50,
              repetitionPenalty: this.ttsRepetitionPenalty(),
              speed: this.monoTtsSpeed(),
              enableTextSplitting: true,
              useParallel: true,
              parallelMode: 'sentences',
              parallelWorkers: this.effectiveTtsWorkers(),
              skipAssembly: true,
              sentencePerParagraph: true,
              skipHeadings: true,
              outputDir: `/tmp/bookforge-tts-${Date.now()}`,
            },
            resumeInfo: {
              success: true,
              sessionId: resumeData.sessionId,
              sessionDir: resumeData.sessionDir,
              processDir: resumeData.processDir || session.sessionDir,
              totalSentences: resumeData.totalSentences,
              totalChapters: resumeData.totalChapters,
              completedSentences: resumeData.completedSentences,
              missingSentences: resumeData.missingSentences,
              missingRanges: resumeData.missingRanges,
              chapters: resumeData.chapters,
            },
            workflowId,
          });
        }
       } else {
        console.log(`[LL-WIZARD] Creating TTS jobs. ProjectDir: ${projectDir}`);

        const asmSourceLang = this.assemblySourceLang();
        const asmTargetLang = this.assemblyTargetLang();

        // Resolve EPUBs for all TTS rows
        // When translation is in the pipeline, use the expected output path (file won't exist yet)
        const translationActive = !this._skippedSteps.has('translate') && this.targetLangs().size > 0;
        const resolvedEpubs = new Map<string, { path: string; source: string; exists: boolean }>();
        for (const row of this.ttsLanguageRows()) {
          if (translationActive) {
            // Translation will create {lang}.epub in stages/02-translate/ before TTS runs
            const expectedPath = `${projectDir}/stages/02-translate/${row.language}.epub`;
            resolvedEpubs.set(row.language, { path: expectedPath, source: 'language', exists: false });
          } else {
            const resolved = await this.epubResolver.resolveEpub({
              projectDir: projectDir,
              audiobookDir: '',
              pipeline: 'language-learning',
              language: row.language
            });
            resolvedEpubs.set(row.language, resolved);
          }
        }

        const audiobooksDir = '';
        const targetEpubPath = assemblyChained ? resolvedEpubs.get(asmTargetLang)?.path : undefined;
        const targetRow = assemblyChained
          ? this.ttsLanguageRows().find(r => r.language === asmTargetLang)
          : undefined;

        // Detect "solo TTS + cached partner" scenario:
        // One assembly language is in TTS rows, the other is already cached
        const ttsRowLangs = new Set(this.ttsLanguageRows().map(r => r.language));
        const sourceInTts = ttsRowLangs.has(asmSourceLang);
        const targetInTts = ttsRowLangs.has(asmTargetLang);
        const soloTts = assemblyChained && (sourceInTts !== targetInTts); // exactly one is in TTS

        // Get cached session dir for the partner language (if solo)
        let cachedPartnerDir = '';
        if (soloTts) {
          const cachedLang = sourceInTts ? asmTargetLang : asmSourceLang;
          const cachedSession = this.availableSessions().find(s => s.language === cachedLang);
          cachedPartnerDir = cachedSession?.sessionDir || '';
          console.log(`[LL-WIZARD] Solo TTS: ${sourceInTts ? asmSourceLang : asmTargetLang} will be TTS'd, ${cachedLang} cached at: ${cachedPartnerDir}`);
        }

        for (const row of this.ttsLanguageRows()) {
          const resolved = resolvedEpubs.get(row.language)!;

          console.log(`[LL-WIZARD] RESOLVED EPUB for ${row.language}:`, {
            resolvedPath: resolved.path,
            source: resolved.source,
            exists: resolved.exists
          });

          // Build metadata with chaining info when assembly is enabled
          const metadata: any = {
            title: `TTS (${row.language.toUpperCase()})`,
            coverPath: this.coverPath() || undefined,
          };

          if (soloTts && (row.language === asmSourceLang || row.language === asmTargetLang)) {
            // Solo TTS: one assembly language being TTS'd, the other is cached
            // This job runs immediately (no placeholder) and chains directly to assembly
            const isSourceLang = row.language === asmSourceLang;
            metadata.bilingualWorkflow = {
              role: 'solo',
              // Pre-fill the cached dir; leave the other empty (filled from TTS output)
              assemblySourceSentencesDir: isSourceLang ? '' : cachedPartnerDir,
              assemblyTargetSentencesDir: isSourceLang ? cachedPartnerDir : '',
              assemblyConfig: {
                projectId: this.projectId(),
                audiobooksDir: audiobooksDir || projectDir,
                bfpPath: this.projectDir(),
                sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${asmTargetLang}.json`,
                pauseDuration: this.pauseDuration(),
                gapDuration: this.gapDuration(),
                title: this.projectTitle() || this.title(),
                sourceLang: asmSourceLang,
                targetLang: asmTargetLang,
                pattern: this.assemblyPattern(),
              }
            };
          } else if (assemblyChained && !soloTts && row.language === asmSourceLang && targetEpubPath && targetRow) {
            // Source TTS: carries chaining config for target TTS + assembly
            metadata.bilingualWorkflow = {
              role: 'source',
              targetEpubPath,
              targetConfig: {
                epubPath: targetEpubPath,
                language: asmTargetLang,
                ttsEngine: this.ttsEngine(),
                voice: targetRow.voice,
                speed: targetRow.speed,
                device: this.ttsDevice(),
                workerCount: this.effectiveTtsWorkers(),
                outputDir: '',
              },
              assemblyConfig: {
                projectId: this.projectId(),
                audiobooksDir: audiobooksDir || projectDir,
                bfpPath: this.projectDir(),
                sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${asmTargetLang}.json`,
                pauseDuration: this.pauseDuration(),
                gapDuration: this.gapDuration(),
                title: this.projectTitle() || this.title(),
                sourceLang: asmSourceLang,
                targetLang: asmTargetLang,
                pattern: this.assemblyPattern(),
              }
            };
          } else if (assemblyChained && !soloTts && row.language === asmTargetLang) {
            // Target TTS: placeholder — skipped by processNext() until source TTS completes
            metadata.bilingualPlaceholder = { role: 'target', projectId: this.projectId() };
          }

          await addJobTracked({
            type: 'tts-conversion',
            epubPath: resolved.path,
            projectDir: projectDir,
            bfpPath: undefined,
            metadata,
            config: {
              type: 'tts-conversion',
              device: this.ttsDevice(),
              language: row.language,
              ttsEngine: this.ttsEngine(),
              fineTuned: row.voice,
              speed: row.speed,
              temperature: this.ttsTemperature(),
              topP: this.ttsTopP(),
              topK: 50,
              repetitionPenalty: this.ttsRepetitionPenalty(),
              enableTextSplitting: true,
              useParallel: this.ttsEngine() === 'xtts',
              parallelMode: 'sentences',
              parallelWorkers: this.effectiveTtsWorkers(),
              sentencePerParagraph: true,
              skipHeadings: true,
              // Skip assembly - only generate sentence audio files
              skipAssembly: true,
              // Output to temp directory
              outputDir: `/tmp/bookforge-tts-${Date.now()}`,
              // The user saw the Continue/Start-fresh toggle (a partial cached
              // session exists for this language) and chose Start fresh — the
              // queue must not auto-resume the old cache, and clears it.
              startFresh: this.partialTtsSessions().some(s => s.language === row.language),
            },
            workflowId,
          });
        }
       }
      }

      // 4. Assembly job
      if (!this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
        const sourceLang = this.assemblySourceLang();
        const targetLang = this.assemblyTargetLang();
        const audiobooksDir = '';

        if (!this._skippedSteps.has('tts')) {
          // Assembly chained to TTS — placeholder activated by target TTS completion handler
          await addJobTracked({
            type: 'bilingual-assembly',
            projectDir: projectDir,
            metadata: {
              title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
              bilingualPlaceholder: { role: 'assembly', projectId: this.projectId() },
            },
            config: {
              type: 'bilingual-assembly',
              projectId: this.projectId(),
              bfpPath: this.projectDir(),
              sourceSentencesDir: '',  // Filled by TTS completion handler
              targetSentencesDir: '',  // Filled by TTS completion handler
              sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
              outputDir: audiobooksDir || projectDir,
              pauseDuration: this.pauseDuration(),
              gapDuration: this.gapDuration(),
              sourceLang,
              targetLang,
              title: this.projectTitle() || this.title(),
              pattern: this.assemblyPattern(),
            },
            workflowId,
          });
        } else {
          // TTS skipped — standalone assembly (sentences must already exist in project sessions dir)
          await addJobTracked({
            type: 'bilingual-assembly',
            projectDir: projectDir,
            metadata: {
              title: `Assembly (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`,
              author: this.author(),
              year: this.year() || undefined,
              coverPath: this.coverPath() || undefined,
            },
            config: {
              type: 'bilingual-assembly',
              projectId: this.projectId(),
              bfpPath: this.projectDir(),
              sourceSentencesDir: this.availableSessions().find(s => s.language === sourceLang)?.sessionDir
                || `${projectDir}/stages/03-tts/sessions/${sourceLang}/sentences`,
              targetSentencesDir: this.availableSessions().find(s => s.language === targetLang)?.sessionDir
                || `${projectDir}/stages/03-tts/sessions/${targetLang}/sentences`,
              sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
              outputDir: audiobooksDir || projectDir,
              pauseDuration: this.pauseDuration(),
              gapDuration: this.gapDuration(),
              sourceLang,
              targetLang,
              title: this.projectTitle() || this.title(),
              pattern: this.assemblyPattern(),
            },
            workflowId,
          });
        }
      }

      // 5. Video Assembly job (optional)
      if (this.generateVideo() && !this._skippedSteps.has('assembly') && this.assemblySourceLang() && this.assemblyTargetLang()) {
        const sourceLang = this.assemblySourceLang();
        const targetLang = this.assemblyTargetLang();
        const videoTitle = this.projectTitle() || this.title();

        // Build external filename: "{Title}. {Author} (language learning, en-de)"
        const langNames: Record<string, string> = {
          en: 'english', de: 'german', es: 'spanish', fr: 'french', it: 'italian',
          pt: 'portuguese', nl: 'dutch', pl: 'polish', ru: 'russian',
          ja: 'japanese', zh: 'chinese', ko: 'korean', ar: 'arabic',
        };
        const srcName = langNames[sourceLang] || sourceLang;
        const tgtName = langNames[targetLang] || targetLang;
        let videoOutputFilename = videoTitle;
        const author = this.author?.() || '';
        if (author && author !== 'Unknown' && !videoTitle.includes(author)) {
          videoOutputFilename += `. ${author}`;
        }
        videoOutputFilename += ` (language learning, ${srcName}-${tgtName})`;

        await addJobTracked({
          type: 'video-assembly',
          projectDir,
          metadata: { title: `Video (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})` },
          config: {
            type: 'video-assembly',
            projectId: this.projectId(),
            bfpPath: videoProjectDir,
            mode: 'bilingual',
            // No m4bPath/vttPath: the bilingual-assembly job queued above hasn't run
            // yet, so those files do not exist to be verified. The bridge resolves
            // them from <projectDir>/output when the job actually starts.
            sentencePairsPath: `${projectDir}/stages/02-translate/sentence_pairs_${targetLang}.json`,
            title: videoTitle,
            sourceLang,
            targetLang,
            resolution: this.videoResolution(),
            outputFilename: videoOutputFilename,
          },
          workflowId,
        });
      }

      console.log('[LLWizard] Jobs added to queue:', {
        workflowId,
        cleanup: !this._skippedSteps.has('cleanup'),
        translations: Array.from(this.targetLangs()),
        ttsRows: this.ttsLanguageRows().map(r => r.language),
        assembly: this.assemblySourceLang() && this.assemblyTargetLang(),
        video: this.generateVideo(),
      });

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[LLWizard] Failed to add to queue:', err);
      const reason = err instanceof Error ? err.message : String(err);
      if (queuedJobTitles.length > 0) {
        // Part of the workflow IS in the queue. Lock the Add button so a
        // retry can't re-submit the whole set and double-queue these jobs.
        this.addedToQueue.set(true);
        void this.dialog.alert({
          title: 'Queue Partially Added',
          type: 'error',
          message: `Adding jobs failed after ${queuedJobTitles.length} job${queuedJobTitles.length === 1 ? ' was' : 's were'} already queued: ${queuedJobTitles.join(', ')}. The remaining jobs were NOT queued.`,
          detail: `${reason}\n\nTo avoid duplicates this wizard will not re-add. Remove the queued job${queuedJobTitles.length === 1 ? '' : 's'} from the queue, then reopen the wizard to retry.`,
        });
      } else {
        void this.dialog.alert({
          title: 'Failed to Add to Queue',
          type: 'error',
          message: 'No jobs were added to the queue.',
          detail: reason,
        });
      }
    } finally {
      this.addingToQueue.set(false);
    }
  }


  private generateWorkflowId(): string {
    return `ll-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Standard (whole-book) submission.
   *
   * The passes go through ONE door — `processing:submit-chain`, which plans in
   * main and hands the plan to the queue — and narration/assembly ride behind
   * them in the same workflow. A run with no passes has no chain to ride, so it
   * gets a master row of its own and the same downstream jobs under it.
   *
   * Everything that can fail while BUILDING the downstream jobs (a resume check,
   * a missing project directory) is done before anything is queued: a workflow
   * that is half in the queue cannot be retried without double-queueing it.
   */
  private async addMonoJobsToQueue(projectDir: string): Promise<void> {
    this.addingToQueue.set(true);

    // Titles of jobs that actually made it into the queue. If a later addJob
    // throws, the catch below names these and blocks a retry from re-adding
    // them (the Add button re-submits the WHOLE job set).
    const queuedJobTitles: string[] = [];
    const addJobTracked = async (request: QueueJobRequest) => {
      const job = await this.queueService.addJob(request);
      queuedJobTitles.push(request.metadata?.title || request.type);
      return job;
    };

    try {
      const passes = this.passes();
      const downstream = await this.buildDownstreamJobs(projectDir);

      if (passes.length === 0 && downstream.length === 0) {
        throw new Error('There is nothing to queue: no passes, no narration and no assembly.');
      }

      if (passes.length > 0) {
        const result = await this.queueService.submitProcessingRun(
          this.chainRequest(projectDir, this.selectedVariantId(), passes),
          downstream,
        );
        if (!result.success) {
          throw new Error(result.error || 'The processing run was refused, and no reason came back.');
        }
        console.log('[PipelineWizard] Submitted processing run:',
          result.plan?.jobs.map(j => j.jobType).join(' → '), '+', downstream.map(j => j.type).join(' → '));
      } else {
        const workflowId = this.generateWorkflowId();
        const isArticle = this.itemType() === 'article';
        const master = await addJobTracked({
          type: 'audiobook',
          epubPath: this.ttsInputPath() || undefined,
          projectDir: isArticle ? projectDir : undefined,
          metadata: { title: this.title(), author: this.author() },
          config: { type: 'audiobook' },
          workflowId,
        });
        for (const request of downstream) {
          await addJobTracked({ ...request, workflowId, parentJobId: master.id });
        }
        console.log('[PipelineWizard] Queued narration/assembly with no passes:',
          downstream.map(j => j.type).join(' → '));
      }

      this.addedToQueue.set(true);
      this.queued.emit();
    } catch (err) {
      console.error('[PipelineWizard] Failed to add mono jobs to queue:', err);
      const reason = err instanceof Error ? err.message : String(err);
      if (queuedJobTitles.length > 0) {
        // Part of the workflow IS in the queue. Lock the Add button so a
        // retry can't re-submit the whole set and double-queue these jobs.
        this.addedToQueue.set(true);
        void this.dialog.alert({
          title: 'Queue Partially Added',
          type: 'error',
          message: `Adding jobs failed after ${queuedJobTitles.length} job${queuedJobTitles.length === 1 ? ' was' : 's were'} already queued: ${queuedJobTitles.join(', ')}. The remaining jobs were NOT queued.`,
          detail: `${reason}\n\nTo avoid duplicates this wizard will not re-add. Remove the queued job${queuedJobTitles.length === 1 ? '' : 's'} from the queue, then reopen the wizard to retry.`,
        });
      } else {
        void this.dialog.alert({
          title: 'Failed to Add to Queue',
          type: 'error',
          message: 'No jobs were added to the queue.',
          detail: reason,
        });
      }
    } finally {
      this.addingToQueue.set(false);
    }
  }

  /**
   * Narration, enhancement and assembly for a standard run — built, not queued.
   *
   * The caller decides where they land: behind a pass chain (same workflow, after
   * the passes) or under a master row of their own. They carry no workflowId or
   * parent: whoever queues them stamps that.
   */
  private async buildDownstreamJobs(projectDir: string): Promise<QueueJobRequest[]> {
    const requests: QueueJobRequest[] = [];
    const isArticle = this.itemType() === 'article';
    const jobProjectDir = this.projectDir() || projectDir;
    const outputDir = this.libraryService.audiobooksPath() || '';
    const wantsTts = this.ttsInThisRun();
    const wantsAssembly = !this._skippedSteps.has('assembly') && !this.assemblyBlockedReason();

    // Pre-flight: RVC opt-in must name a voice. Validated BEFORE any job is built
    // so it fails cleanly (no partial workflow) instead of silently dropping the
    // pass (no-fallbacks rule). The engine-not-installed case is handled in the
    // template (the toggle is replaced by a download prompt), so an enabled toggle
    // with no voice is the only inconsistent state left to catch here.
    if (wantsAssembly
        && this.rvcEnhanceEnabled()
        && this.componentService.isInstalled('rvc-env')
        && !this.rvcEnhanceVoiceId()) {
      throw new Error('RVC enhancement is on but no enhancement voice is selected. Pick a voice or turn RVC off.');
    }

    // The optional video job reads the assembly's output from under the PROJECT
    // directory, so that directory has to be KNOWN. Checked here, before anything
    // is queued: empty would queue a job pointed at "/output" that fails at run
    // time, with a path nobody can place, long after this click.
    if (this.generateVideo() && wantsAssembly && !this.projectDir()) {
      throw new Error(
        'Cannot queue the video job: this project has no project directory (projectDir), '
        + 'so there is nowhere to read the assembled audiobook from.',
      );
    }

    // 1. Narration
    if (wantsTts) {
      const skipAssembly = wantsAssembly;  // e2a produces sentences only; we reassemble ourselves
      const partial = this.partialTtsSessions()[0];

      if (this.continueTts() && partial) {
        const electron = window.electron as any;
        const resumeCheck = await electron.parallelTts.checkResumeFromDir(partial.sessionDir);
        const resumeData = resumeCheck?.data;
        if (!resumeData?.success) {
          throw new Error(`Cannot resume the partial TTS session: ${resumeCheck?.data?.error || 'the cached session could not be read'}`);
        }
        if (!resumeData.sourceEpubPath) {
          throw new Error('Cannot resume the partial TTS session: the cached session is missing its source EPUB path');
        }

        requests.push({
          type: 'tts-conversion',
          epubPath: resumeData.sourceEpubPath,
          bfpPath: jobProjectDir,
          metadata: {
            title: 'TTS (Continue)',
            bookTitle: this.title(),
            author: this.author(),
            year: this.year() || undefined,
            coverPath: this.coverPath() || undefined,
            outputFilename: this.generateOutputFilename(),
          },
          config: {
            type: 'tts-conversion',
            language: this.monoTtsLanguage(),
            // Engine/voice/sampling from the wizard's controls (pre-filled from the
            // original run, plus any change the user made). Without these the queue
            // would fall back to xtts/ScarlettJohansson. Voice defaults to the ORIGINAL
            // persisted voice if the picker somehow wasn't populated — never a stock default.
            ttsEngine: this.ttsEngine(),
            fineTuned: this.monoTtsVoice() || resumeData.renderSettings?.fineTuned,
            device: this.ttsDevice(),
            temperature: this.ttsTemperature(),
            topP: this.ttsTopP(),
            topK: 50,
            repetitionPenalty: this.ttsRepetitionPenalty(),
            speed: this.monoTtsSpeed(),
            enableTextSplitting: true,
            useParallel: true,
            parallelMode: 'sentences',
            parallelWorkers: this.effectiveTtsWorkers(),
            outputDir,
            skipAssembly,
            // Final-assembly denoise (only consumed when this job assembles inline)
            finalDenoise: this.finalDenoise(),
          },
          resumeInfo: {
            success: true,
            sessionId: resumeData.sessionId,
            sessionDir: resumeData.sessionDir,
            processDir: resumeData.processDir || partial.sessionDir,
            totalSentences: resumeData.totalSentences,
            totalChapters: resumeData.totalChapters,
            completedSentences: resumeData.completedSentences,
            missingSentences: resumeData.missingSentences,
            missingRanges: resumeData.missingRanges,
            chapters: resumeData.chapters,
          },
        });
      } else {
        const ttsConfig: Partial<TtsConversionConfig> = {
          type: 'tts-conversion',
          device: this.ttsDevice(),
          language: this.monoTtsLanguage(),
          ttsEngine: this.ttsEngine(),
          fineTuned: this.monoTtsVoice(),
          temperature: this.ttsTemperature(),
          topP: this.ttsTopP(),
          topK: 50,
          repetitionPenalty: this.ttsRepetitionPenalty(),
          speed: this.monoTtsSpeed(),
          enableTextSplitting: true,
          useParallel: true,
          parallelMode: 'sentences',
          parallelWorkers: this.effectiveTtsWorkers(),
          outputDir,
          skipAssembly,
          // Final-assembly denoise (only consumed when this job assembles inline)
          finalDenoise: this.finalDenoise(),
          // The user saw the Continue/Start-fresh toggle (partial cached
          // session exists) and chose Start fresh — the queue must not
          // auto-resume the old cache, and clears it.
          startFresh: this.partialTtsSessions().length > 0,
        };

        requests.push({
          type: 'tts-conversion',
          // The book this run leaves behind. When passes are queued ahead of it
          // the file does not exist yet — the chain writes it before this runs.
          epubPath: this.ttsInputPath(),
          projectDir: isArticle ? projectDir : undefined,
          bfpPath: isArticle ? undefined : jobProjectDir,
          metadata: {
            title: 'TTS',
            bookTitle: this.title(),
            author: this.author(),
            year: this.year() || undefined,
            coverPath: this.coverPath() || undefined,
            outputFilename: this.generateOutputFilename(),
          },
          config: ttsConfig,
        });
      }
    }

    // 2. Enhancement + assembly (M4B + VTT)
    if (wantsAssembly) {
      const audiobookDir = `${projectDir.replace(/\\/g, '/')}/output`;

      // RVC voice enhancement runs as its OWN queue step before reassembly (so it
      // shows a distinct job with a per-sentence ETA). It writes an enhanced set
      // to [library]/tmp which the reassembly job then assembles + deletes.
      const rvcEnabled = this.rvcEnhanceEnabled()
        && !!this.rvcEnhanceVoiceId()
        && this.componentService.isInstalled('rvc-env');
      const rvcParams = rvcEnabled ? {
        voiceId: this.rvcEnhanceVoiceId(),
        indexRate: this.rvcEnhanceIndexRate(),
        protectRate: this.rvcEnhanceProtectRate(),
        nSemitones: this.rvcEnhanceNSemitones(),
        // Denoise rides on the RVC job so it runs BEFORE conversion (denoise →
        // RVC → assembly); the reassembly job sees the pre-enhanced set and
        // knows not to re-run it.
        finalDenoise: this.finalDenoise(),
      } : null;

      if (wantsTts) {
        // MODE A: TTS + Assembly chained — session data discovered at runtime by queue service
        if (rvcParams) {
          requests.push({
            type: 'rvc-enhancement',
            bfpPath: jobProjectDir,
            config: {
              type: 'rvc-enhancement',
              sessionId: '', sessionDir: '', processDir: '',  // filled at runtime via session discovery
              ...rvcParams,
            },
            metadata: { title: this.title(), author: this.author(), year: this.year() || undefined },
          });
        }
        requests.push({
          type: 'reassembly',
          bfpPath: jobProjectDir,
          config: {
            type: 'reassembly',
            sessionId: '',   // filled at runtime via session discovery
            sessionDir: '',
            processDir: '',
            outputDir: audiobookDir,
            metadata: {
              title: this.title() || '',
              author: this.author() || '',
              coverPath: this.coverPath() || undefined,
              year: this.year() || undefined,
              outputFilename: this.generateOutputFilename(),
            },
            excludedChapters: [],
            // Three opt-in assembly passes — all default OFF (see the toggles above).
            finalDenoise: this.finalDenoise(),
            applyDeRing: this.applyDeRing(),
          },
          metadata: {
            title: this.title(),
            author: this.author(),
            year: this.year() || undefined,
          },
        });
      } else if (this.cachedSession()) {
        // MODE B: no narration in this run — reassemble the cached session
        const session = this.cachedSession();
        const totalChapters = session.chapters?.filter((ch: any) => !ch.excluded)?.length || 0;

        const reassemblyConfig: ReassemblyJobConfig = {
          type: 'reassembly',
          sessionId: session.sessionId,
          sessionDir: session.sessionDir,
          processDir: session.processDir,
          outputDir: audiobookDir,
          totalChapters,
          metadata: {
            title: this.title() || session.metadata?.title || '',
            author: this.author() || session.metadata?.author || '',
            year: this.year() || session.metadata?.year,
            coverPath: this.coverPath() || session.metadata?.coverPath,
            outputFilename: this.generateOutputFilename(),
          },
          excludedChapters: [],
          // Three opt-in assembly passes — all default OFF (see the toggles above).
          finalDenoise: this.finalDenoise(),
          applyDeRing: this.applyDeRing(),
        };

        if (rvcParams) {
          requests.push({
            type: 'rvc-enhancement',
            epubPath: session.processDir,
            bfpPath: jobProjectDir,
            config: {
              type: 'rvc-enhancement',
              sessionId: session.sessionId,
              sessionDir: session.sessionDir,
              processDir: session.processDir,
              ...rvcParams,
            },
            metadata: { title: reassemblyConfig.metadata.title, author: reassemblyConfig.metadata.author, year: reassemblyConfig.metadata.year },
          });
        }
        requests.push({
          type: 'reassembly',
          epubPath: session.processDir,
          bfpPath: jobProjectDir,
          config: reassemblyConfig,
          metadata: { title: reassemblyConfig.metadata.title, author: reassemblyConfig.metadata.author, year: reassemblyConfig.metadata.year },
        });
      }
    }

    // 3. Video (optional, after audio assembly)
    if (this.generateVideo() && wantsAssembly) {
      let videoOutputFilename = this.title() || 'audiobook';
      const videoAuthor = this.author() || '';
      if (videoAuthor && videoAuthor !== 'Unknown' && !videoOutputFilename.includes(videoAuthor)) {
        videoOutputFilename += `. ${videoAuthor}`;
      }

      requests.push({
        type: 'video-assembly',
        bfpPath: jobProjectDir,
        metadata: { title: 'Video' },
        config: {
          type: 'video-assembly',
          projectId: jobProjectDir,
          bfpPath: jobProjectDir,
          mode: 'monolingual',
          // No m4bPath/vttPath. These were `<projectDir>/output/audiobook.m4b|.vtt`,
          // which the monolingual assembler never writes — it names the file after
          // the book's title — so the pair was a fiction the bridge had to work
          // around every time. The bridge resolves both from <projectDir>/output when
          // the job runs, by which point the assembly step has produced them.
          title: this.title(),
          sourceLang: this.monoTtsLanguage(),
          resolution: this.videoResolution(),
          outputFilename: videoOutputFilename,
        },
      });
    }

    return requests;
  }

  /**
   * M4B filename: respects the manifest's saved outputFilename when present,
   * otherwise derives "Title. LastName, FirstName. (Year).m4b".
   */
  private generateOutputFilename(): string {
    const saved = this.outputFilename().trim();
    if (saved) return saved;

    let name = this.title() || 'Audiobook';

    let authorPart = '';
    const contribs = this.contributors();
    if (contribs && contribs.length > 0) {
      const c = contribs[0];
      if (c.last && c.first) authorPart = `${c.last}, ${c.first}`;
      else authorPart = c.last || c.first || '';
    } else if (this.author()) {
      const parts = this.author().trim().split(/\s+/);
      authorPart = parts.length >= 2 ? `${parts.pop()}, ${parts.join(' ')}` : this.author();
    }

    if (authorPart) name += `. ${authorPart}`;
    if (this.year()) name += `. (${this.year()})`;
    // Guard the "Last, First M." author case (e.g. "Green, Simon R.") whose trailing
    // period collides with the ". (Year)" separator → "…R.. (Year)". Base only, before ext.
    return `${collapseFilenameDots(name)}.m4b`;
  }

  /**
   * Resolve "latest" source EPUB based on pipeline stage
   */
  private resolveLatestSource(stage: 'cleanup' | 'translate'): string {
    const source = this.sourceSignalFor(stage)();

    if (source !== 'latest') {
      return source;
    }

    const epubs = this.availableEpubs();
    const projectDir = this.effectiveProjectDir();

    if (stage === 'cleanup') {
      // Cleanup input: most recently modified source file
      // Exclude cleanup/translation outputs — we're producing those, not consuming them
      const sourceOnly = new Set(['cleaned.epub', 'simplified.epub', 'translated.epub']);
      for (const e of epubs) { if (e.isTranslated) sourceOnly.add(e.filename); }
      const best = this.getMostRecentEpub(epubs, sourceOnly);
      if (best) return best.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub');
      if (original) return original.path;
    } else if (stage === 'translate') {
      // Translate input: most recently modified wins (exclude translation outputs)
      const exclude = new Set<string>();
      for (const e of epubs) {
        if (e.isTranslated || e.filename === 'translated.epub') exclude.add(e.filename);
      }
      const best = this.getMostRecentEpub(epubs, exclude);
      if (best) return best.path;
      const simplified = epubs.find(e => e.filename === 'simplified.epub');
      if (simplified) return simplified.path;
      const cleaned = epubs.find(e => e.filename === 'cleaned.epub');
      if (cleaned) return cleaned.path;
      const exported = epubs.find(e => e.filename === 'exported.epub');
      if (exported) return exported.path;
      const original = epubs.find(e => e.filename === 'original.epub');
      if (original) return original.path;
    }

    // Fallback: first available EPUB
    if (epubs.length > 0) {
      return epubs[0].path;
    }

    // Ultimate fallback
    return `${projectDir}/source/original.epub`;
  }


  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getLanguageName(code: string): string {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    if (lang) return lang.name;
    if (code === 'en') return 'English';
    return code.toUpperCase();
  }

  getFlagCss(code: string): string {
    const flags: Record<string, string> = {
      'de': 'linear-gradient(to bottom, #000 33.3%, #DD0000 33.3% 66.6%, #FFCE00 66.6%)',
      'es': 'linear-gradient(to bottom, #AA151B 25%, #F1BF00 25% 75%, #AA151B 75%)',
      'fr': 'linear-gradient(to right, #002395 33.3%, #FFF 33.3% 66.6%, #ED2939 66.6%)',
      'it': 'linear-gradient(to right, #008C45 33.3%, #F4F5F0 33.3% 66.6%, #CD212A 66.6%)',
      'pt': 'linear-gradient(to right, #006600 40%, #FF0000 40%)',
      'nl': 'linear-gradient(to bottom, #AE1C28 33.3%, #FFF 33.3% 66.6%, #21468B 66.6%)',
      'pl': 'linear-gradient(to bottom, #FFF 50%, #DC143C 50%)',
      'ru': 'linear-gradient(to bottom, #FFF 33.3%, #0039A6 33.3% 66.6%, #D52B1E 66.6%)',
      'ja': 'radial-gradient(circle, #BC002D 25%, #FFF 25%)',
      'zh': 'radial-gradient(circle at 28% 35%, #FFDE00 8%, #DE2910 8%)',
      'ko': 'radial-gradient(circle at 50% 40%, #CD2E3A 18%, transparent 18%), radial-gradient(circle at 50% 60%, #0047A0 18%, transparent 18%), linear-gradient(#FFF, #FFF)',
      'el': 'repeating-linear-gradient(to bottom, #0D5EAF 0%, #0D5EAF 11.1%, white 11.1%, white 22.2%)',
    };
    return flags[code] || 'linear-gradient(#666, #666)';
  }
}
