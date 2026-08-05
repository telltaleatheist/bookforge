import {
  Component, DestroyRef, inject, input, output, signal, computed, effect, untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService, WhisperModelStatus } from '../../../../core/services/electron.service';
import { ComponentService } from '../../../../core/services/component.service';
import { QueueService } from '../../../queue/services/queue.service';
import { VariantImportService } from '../../services/variant-import.service';
import { DiffViewComponent } from '../../../audiobook/components/diff-view/diff-view.component';
import { MetadataEditorComponent, EpubMetadata } from '../../../audiobook/components/metadata-editor/metadata-editor.component';
import { StudioItem } from '../../models/studio.types';
import { AppliedPass, AppliedPassKind, ProjectVariant, ResolvedProjectVariant } from '../../../../core/models/manifest.types';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';
import { StudioAnalysisTarget, studioManifestProjectId } from '../../analysis-target';
import type { PassDiffEntry } from '@shared/processing/pass-types';
import type { BookResetSummary } from '@shared/processing/reset-book';
import { samePath } from '@shared/document/same-path';
import {
  STAR_LABELS,
  STAR_MEANINGS,
  latestPassByKind,
  starForPassKind,
  starSlotsFor,
  versionFamily,
  type VersionFamilyInput,
  type VersionStar,
} from '@shared/document/version-family';

interface VersionRow {
  id: string; type: string; label: string; description: string;
  path: string; extension: string; language?: string;
  modifiedAt?: string; fileSize?: number; editable: boolean; icon: string;
  diffRecordPath?: string;   // presence => this version has a pre-computed diff to review
  diffOriginalPath?: string; // the original it was computed against (resolved locally, if it exists)
  /** The file the editor is pointed at for this row, when it is not this row's own. */
  openPath?: string;
  /** The 'archive' row only: the manifest variant that IS this file. */
  variantId?: string;
  /** The 'archive' and 'working' rows: the archive original this family is bound to. */
  primaryPath?: string;
  /** The 'working' row only: the binding's recorded stage boundaries. */
  stageBoundaries?: Array<{ stage: string; finishedAt: string }>;
  /** The 'exported' row only: when Reflow wrote this book, if it was recorded. */
  builtAt?: string;
  // Present only on the synthetic 'analysis' entry (its durable version pin):
  analysisTarget?: { versionId: string | null; versionType: string; versionLabel: string };
  analysisFlagCount?: number;
  analysisIsCheckpoint?: boolean;
}

/** The TTS sentence cache for this project (per-sentence audio already rendered),
 *  read from the durable project cache via reassembly.getBfpSession. */
interface SentenceCacheInfo {
  language?: string;
  totalSentences: number;
  completedSentences: number;
  percentComplete: number;
  complete: boolean;
}

/**
 * One provenance badge: a pass KIND, collapsed latest-wins, with the review of
 * what its latest run changed hanging off it.
 *
 * A pass is not a version (docs/PIPELINE_V2_PLAN.md), so there is no row for it
 * — but "Review changes" is the only way to see what a pass did, so it moved
 * onto the badge rather than out of the app.
 */
/**
 * One star column on a document row: what it is, whether it is lit, and — when
 * the pass behind it recorded one — the review of what it changed.
 *
 * Owen, third real session: "any time a process is run on a file, there should
 * be a diff with a 'review changes' button on that file… and it should be linked
 * to the file it was applied to." The star IS the record that the pass ran, so
 * the star is the way in to what it did. `review` is null for a star that is
 * unlit AND for a lit one whose pass left no diff (a job that died before it
 * wrote one) — and a star with no review must never look pressable, or two
 * identical-looking stars would behave differently.
 */
interface StarSlot {
  id: VersionStar;
  label: string;
  lit: boolean;
  tooltip: string;
  /** The latest run of this pass's recorded diff, or null. */
  review: { diffPath: string; reportPath: string; kind: AppliedPassKind; when: string } | null;
  /** What pressing it does, in words. Null exactly when `review` is. */
  action: string | null;
}

/** One document row, arranged into the family and carrying its derived state. */
interface DocumentFamilyRow {
  v: VersionRow;
  /** 0 for the archive parent (and for rows outside the family), 1 for a child. */
  depth: 0 | 1;
  slots: StarSlot[];
  staleness: string | null;
}

interface ProvenanceBadge {
  kind: AppliedPassKind;
  label: string;
  /** How many times this kind ran. The badge describes the LAST one. */
  count: number;
  tooltip: string;
  /** The latest run's recorded diff, when it left one. Null when it did not. */
  review: { diffPath: string; reportPath: string; when: string } | null;
}

/** `foundry footnotes --epub`'s own review report, written beside its diff. */
interface FootnotesReport {
  model?: string;
  askEverything?: boolean;
  totals?: {
    documents: number;
    documentsEdited: number;
    unitsAsked: number;
    unitsFired: number;
    unitsNoteBody: number;
    unitsIndex: number;
    deletionsApplied: number;
    deletionsRejected: number;
  };
}

/** Pass display names. Shared by the badges and the diff rows so one pass is
 *  never called two things in the same panel. */
const PASS_LABELS: Record<AppliedPassKind, string> = {
  'get-text': 'Get Text',
  blocks: 'Detect blocks',
  reflow: 'Build the book',
  footnotes: 'Footnote removal',
  simplify: 'Simplify',
  translate: 'Translate',
  // Retired, and named anyway: books processed before Aug 2026 carry these, and a
  // badge that could not name a pass would shorten a real book's own history.
  tesseract: 'Tesseract',
  'ocr-correction': 'OCR correction',
  detection: 'Detection',
};

const AUDIO_EXTS = new Set([
  'm4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif',
]);

/**
 * StudioVersionsComponent - the "Versions" surface of the four-tab book view.
 *
 * Top: **Book versions** — the distinct editions/languages/formats of this book
 * (each an independent file with its own free-text descriptor + metadata; the
 * audiobook is a variant too). Add via button or drag/drop; edit metadata per
 * variant; set which is primary; delete at will.
 *
 * Below: the pipeline document versions (Original / Cleaned / …) with Edit /
 * Review Changes / Export / Delete, the sentence cache, and audio outputs.
 */
@Component({
  selector: 'app-studio-versions',
  standalone: true,
  imports: [CommonModule, FormsModule, DiffViewComponent, MetadataEditorComponent, DesktopSelectComponent],
  host: { '[class.comparing]': '!!comparing()' },
  template: `
    @if (comparePass(); as cmp) {
      <div class="compare-wrap">
        <div class="compare-bar">
          <button class="back" (click)="closeCompare()">← Back to versions</button>
          <span class="compare-title">{{ cmp.title }}</span>
          <span class="compare-when">{{ cmp.when }}</span>
        </div>
        @if (passReport(); as rep) {
          <div class="pass-report" [title]="rep.detail">{{ rep.summary }}</div>
        }
        <app-diff-view [passDiffPath]="cmp.diffPath" />
      </div>
    } @else if (comparePaths(); as cmp) {
      <div class="compare-wrap">
        <div class="compare-bar">
          <button class="back" (click)="closeCompare()">← Back to versions</button>
          <span class="compare-title">{{ cmp.labelA }} <span class="vs">vs</span> {{ cmp.labelB }}</span>
        </div>
        <app-diff-view [originalPath]="cmp.a" [cleanedPath]="cmp.b" />
      </div>
    } @else {
      <div class="versions">
        <!-- What has been done to the book EPUB, from its provenance record.
             One badge per pass KIND: a book run through OCR correction twice is
             still "OCR-corrected", and the tooltip carries the detail.

             "Start over" lives HERE, next to the history it erases, and is shown
             whenever the project could carry processing state at all — a run
             that died before it recorded anything is exactly the case the user
             needs it for, and hiding it until a badge appears would hide it then. -->
        @if (projectDir()) {
          <div class="section-head">
            <span>What's been done</span>
            <button class="start-over" (click)="startOver()"
                    [disabled]="!canStartOver() || resetting()"
                    [title]="startOverTitle()">
              {{ resetting() ? 'Starting over…' : 'Start over' }}
            </button>
          </div>
        }
        @if (provenanceBadges().length > 0) {
          <div class="provenance">
            @for (b of provenanceBadges(); track b.kind) {
              <span class="pbadge" [title]="b.tooltip">
                {{ b.label }}@if (b.count > 1) { <span class="pcount">×{{ b.count }}</span> }
                @if (b.review) {
                  <button class="preview" (click)="startPassCompare(b)"
                          [title]="b.tooltip">Review changes</button>
                }
              </span>
            }
          </div>
        }
        @if (passDiffError(); as e) {
          <div class="pass-err">{{ e }}</div>
        }
        <!--
          Said, never only logged. The list below is kept when a read fails —
          right for a transient lock on a synced drive — but a permanent failure
          (a binding record that will not parse) would otherwise leave a stale or
          empty list on screen with no explanation, which is the exact experience
          of work that has no door.
        -->
        @if (versionsError(); as e) {
          <div class="pass-err">{{ e }}</div>
        }

        <!-- Book versions (variants) -->
        <div class="section-head">
          <span>Book versions</span>
          <button class="add-version" (click)="addViaDialog()" [disabled]="busy()">
            {{ busy() ? 'Adding…' : '+ Add version' }}
          </button>
        </div>

        <div class="vzone"
             [class.dragover]="vDragOver()"
             (dragenter)="onVDragEnter($event)"
             (dragover)="onVDragOver($event)"
             (dragleave)="onVDragLeave($event)"
             (drop)="onVDrop($event)">
          @if (importProgress(); as ip) {
            <div class="vconvert">
              <span class="vc-label" [title]="ip.name">Converting “{{ ip.name }}” to M4B…</span>
              <div class="vc-bar"><div class="vc-fill" [style.width.%]="ip.fraction * 100"></div></div>
              <span class="vc-pct">{{ ip.fraction * 100 | number:'1.0-0' }}%</span>
            </div>
          }
          @if (ebookVariants().length === 0) {
            <div class="vempty">
              Drop an ebook here — or click <b>Add version</b> — to add another
              edition, language, or format of this book. Audiobooks appear in the
              <b>Audio</b> section below.
            </div>
          } @else {
            @for (v of ebookVariants(); track v.id) {
              <div class="vrow" [class.open]="openId() === v.id">
                <div class="vhead" (click)="toggleEditor(v)">
                  <span class="ricon">{{ variantIcon(v) }}</span>
                  <div class="rinfo">
                    <div class="rlabel">
                      {{ variantTitle(v) }}
                      @if (isPrimary(v)) { <span class="badge">Primary</span> }
                    </div>
                    <div class="rdesc">{{ variantSubtitle(v) }}</div>
                    @if (variantFilename(v); as fn) { <div class="rfile" [title]="fn">{{ fn }}</div> }
                  </div>
                  <div class="ractions" (click)="$event.stopPropagation()">
                    @if (!isPrimary(v)) {
                      <button class="act" (click)="setPrimary(v)" title="Make this the version that represents the project">Set primary</button>
                    }
                    @if (canAnalyzeVariant(v) && !variantIsAnalysisTarget(v)) {
                      <button class="act" (click)="emitGenerateAnalysisVariant(v)" title="Analyze this version for rhetorical manipulation and problematic patterns">Generate analysis</button>
                    }
                    @if (canOpenInEditor(v)) {
                      <button class="act" (click)="openVariant(v)" title="Open this file in the editor">Open</button>
                    }
                    <button class="act" (click)="exportVariant(v)" title="Save a copy to your computer">Export</button>
                    <button class="act danger" (click)="remove(v)" title="Delete this version">Delete</button>
                  </div>
                </div>

                @if (openId() === v.id) {
                  <div class="veditor">
                    <div class="drow">
                      <label>Version description</label>
                      <input type="text"
                             [ngModel]="descriptorValue(v)"
                             (ngModelChange)="onDescriptor(v, $event)"
                             placeholder="e.g. German · First edition · Unabridged" />
                      <span class="dhint">How this version differs. Leave blank to fall back to the cover + title.</span>
                    </div>

                    @if (otherVariants(v).length > 0) {
                      <div class="drow pull">
                        <label>Copy details from</label>
                        <select [ngModel]="''" (ngModelChange)="pullFrom(v, $event)">
                          <option value="">Choose a version…</option>
                          @for (o of otherVariants(v); track o.id) {
                            <option [value]="o.id">{{ variantTitle(o) }}{{ o.descriptor ? ' — ' + o.descriptor : '' }}</option>
                          }
                        </select>
                      </div>
                    }

                    <app-metadata-editor
                      [metadata]="editorMeta(v)"
                      [saving]="savingId() === v.id"
                      [filenameExt]="v.format"
                      (coverChange)="onCover(v, $event)"
                      (save)="saveVariant(v, $event)" />
                  </div>
                }
              </div>
            }
          }
        </div>

        <!-- The document family: the archive original, and the working copy and
             book EPUB indented under it. One family, not a flat list — and no
             pass-shaped rows, because a pass is not a version. -->
        <div class="section-head">
          <span>Documents</span>
        </div>

        @if (loading()) {
          <div class="muted">Loading versions…</div>
        } @else if (documentRows().length === 0) {
          <div class="muted">No document versions yet.</div>
        } @else {
          @for (row of documentRows(); track row.v.id) {
            <div class="row" [class.child]="row.depth === 1"
                 [class.clickable]="row.v.editable" (click)="onDocRowClick(row.v)">
              <span class="ricon">{{ row.v.icon || '\u{1F4C4}' }}</span>
              <div class="rinfo">
                <div class="rlabel">{{ row.v.label }} <span class="ext">.{{ row.v.extension }}</span></div>
                <div class="rdesc">{{ rowDescription(row) }}</div>
                @if (row.slots.length > 0) {
                  <!-- The stars are the record that a pass ran, so a star whose
                       pass left a diff IS the way in to what it changed. One that
                       did not is a plain span: two identical-looking stars where
                       only one does something is worse than no affordance. -->
                  <div class="stars">
                    @for (s of row.slots; track s.id) {
                      @if (s.review) {
                        <button type="button" class="star lit review" [title]="s.action"
                                [attr.aria-label]="s.action"
                                (click)="$event.stopPropagation(); openStarReview(s)">
                          <span class="sglyph">★</span>{{ s.label }}<span class="sgo">see changes</span>
                        </button>
                      } @else {
                        <span class="star" [class.lit]="s.lit" [title]="s.tooltip">
                          <span class="sglyph">{{ s.lit ? '★' : '☆' }}</span>{{ s.label }}
                        </span>
                      }
                    }
                  </div>
                  @if (rowHasReviewableStar(row)) {
                    <div class="stars-hint">Click a ★ pass to see the changes it made to this file.</div>
                  }
                }
                @if (row.staleness; as stale) {
                  <div class="stale">{{ stale }}</div>
                }
              </div>
              <div class="ractions" (click)="$event.stopPropagation()">
                @if (row.staleness) {
                  <button class="act" (click)="rebuildBook()" [disabled]="rebuilding()"
                          title="Build the book again from the working copy, so it includes your latest edits">
                    {{ rebuilding() ? 'Queueing…' : 'Rebuild' }}
                  </button>
                }
                @if (hasSkippedReport(row.v)) { <button class="act" (click)="skipped.emit()">Skipped</button> }
                @if (hasDiffRecord(row.v)) {
                  <button class="act" (click)="startCompare(row.v)" title="Review the changes made to produce this version">Review Changes</button>
                }
                @if (isEpub(row.v) && !docIsAnalysisTarget(row.v)) {
                  <button class="act" (click)="emitGenerateAnalysisDoc(row.v)" title="Analyze this version for rhetorical manipulation and problematic patterns">Generate analysis</button>
                }
                @if (row.v.editable) {
                  <button class="act" (click)="openDoc(row.v)" [title]="openTitle(row.v)">Open</button>
                } @else if (row.v.type === 'archive') {
                  <!-- Shown DISABLED rather than omitted. Opening this book lands
                       on the working copy (RULED 2026-08-04 — you never start on a
                       read-only book), so an Open here would be a second button
                       doing exactly what the row below it does. The button that
                       says why beats a gap the user has to interpret. -->
                  <button class="act" disabled [title]="openTitle(row.v)">Open</button>
                }
                @if (exportable(row.v)) {
                  <button class="act" (click)="exportDoc.emit(row.v.path)" [title]="exportTitle(row.v)">Export</button>
                }
                @if (deletable(row.v)) {
                  <button class="act danger" (click)="removeDoc(row.v)" [title]="deleteTitle(row.v)">Delete</button>
                }
                @if (row.v.type === 'original') {
                  <button class="act danger" (click)="resetEdits()"
                          title="Clear all editor edits for this source and start fresh (the archive file is untouched)">Reset edits</button>
                }
              </div>
            </div>
          }
        }

        <!-- Analysis (content-analysis report — shown like a version, pinned to one) -->
        @if (analysisEntry(); as a) {
          <div class="section-head">Analysis</div>
          <div class="row">
            <span class="ricon">🔍</span>
            <div class="rinfo">
              <div class="rlabel">
                Content analysis
                @if (a.analysisIsCheckpoint) { <span class="ext">partial</span> }
              </div>
              <div class="rdesc">{{ analysisRowDesc(a) }}</div>
            </div>
            <div class="ractions">
              <div class="specials">
                @if (analysisTargetId()) {
                  <button class="act" (click)="regenerateAnalysis(a)"
                          title="Re-run the content analysis on the same version">Regenerate</button>
                }
              </div>
              @if (a.path) {
                <button class="act" (click)="viewAnalysis.emit({ path: a.path })"
                        title="Open the analyzed version with the flags highlighted">View</button>
                <button class="act" (click)="exportDoc.emit(a.path)"
                        title="Save a copy of the analyzed file">Export</button>
              }
              <button class="act danger" (click)="removeAnalysis()"
                      title="Delete the content-analysis report">Delete</button>
            </div>
          </div>
        }

        <!-- Sentence cache (per-sentence audio already rendered) -->
        @if (cache(); as c) {
          <div class="section-head">Sentence cache</div>
          <div class="row">
            <span class="ricon">\u{1F5C2}\u{FE0F}</span>
            <div class="rinfo">
              <div class="rlabel">
                Rendered sentences
                @if (c.complete) { <span class="ext">complete</span> }
                @else { <span class="ext">{{ c.percentComplete }}% — incomplete</span> }
              </div>
              <div class="rdesc">
                {{ c.completedSentences | number }} / {{ c.totalSentences | number }} sentences cached{{ c.language ? ' · ' + c.language : '' }}
              </div>
            </div>
            <div class="ractions">
              <div class="specials">
                @if (!c.complete) {
                  <button class="act primary" (click)="continueJob.emit()"
                          title="Resume rendering the remaining sentences in the Processing tab, with the same settings as before">Continue</button>
                }
                <button class="act" (click)="assemble.emit()"
                        title="Assemble the cached sentences into a finished audiobook in the Processing tab">Assemble</button>
                <button class="act" (click)="correctSentences.emit()"
                        title="Listen to the rendered sentences and regenerate any that sound wrong, then rebuild">🔧 Correct Sentences</button>
              </div>
              <button class="act danger" (click)="deleteCache()" title="Delete all cached sentence audio for this book">Delete</button>
            </div>
          </div>
        }

        <!-- Audio (audiobook variants — one row each, the single home for M4Bs) -->
        @if (audiobookVariants().length > 0) {
          <div class="section-head audio">Audio</div>
          @for (v of audiobookVariants(); track v.id) {
            <div class="vrow" [class.open]="openId() === v.id">
              <div class="vhead" (click)="toggleEditor(v)">
                <span class="ricon">{{ variantIcon(v) }}</span>
                <div class="rinfo">
                  <div class="rlabel">{{ variantTitle(v) }}</div>
                  <div class="rdesc">{{ variantSubtitle(v) }}</div>
                  @if (narratorFor(v); as nar) {
                    <div class="narrator" title="Who narrated this audiobook"><span class="nlabel">Narrator</span>{{ nar }}</div>
                  }
                  @if (variantFilename(v); as fn) { <div class="rfile" [title]="fn">{{ fn }}</div> }
                </div>
                <div class="ractions" (click)="$event.stopPropagation()">
                  <div class="specials">
                    <button class="act" [class.active]="isProfessional(v)" (click)="setProfessional(v, !isProfessional(v))" [title]="isProfessional(v) ? 'Marked professionally read — click to unset' : 'Mark as professionally read'">{{ isProfessional(v) ? '★ Professional' : 'Mark professional' }}</button>
                    @if (canGenerateSentences(v)) {
                      <button class="act" (click)="openSentencePicker(v)"
                              title="Transcribe this audiobook into synced on-screen text">Generate sentences</button>
                    }
                    @if (canRegenerateSentences(v)) {
                      <button class="act" type="button" (click)="emitGenerateAudiobookAnalysis(v)"
                              title="Add analysis of this audiobook’s synced sentences to the queue">
                        Generate analysis
                      </button>
                      <button class="act" (click)="openSentencePicker(v)"
                              title="Re-transcribe this audiobook, replacing the current synced text">Regenerate sentences</button>
                    }
                  </div>
                  <button class="act primary" (click)="listenVariant(v)"
                          title="Play this audiobook in the player window">Listen</button>
                  <button class="act" (click)="exportAudioVariant(v)"
                          title="Save a copy to your computer">Export</button>
                  <button class="act danger" (click)="remove(v)"
                          title="Delete the finished audiobook file (the rendered sentence cache is kept)">Delete</button>
                </div>
              </div>

              @if (openId() === v.id) {
                <div class="veditor">
                  <div class="drow">
                    <label>Version description</label>
                    <input type="text"
                           [ngModel]="descriptorValue(v)"
                           (ngModelChange)="onDescriptor(v, $event)"
                           placeholder="e.g. Unabridged · Bilingual (en→de)" />
                    <span class="dhint">How this version differs. Leave blank to fall back to the cover + title.</span>
                  </div>

                  @if (otherVariants(v).length > 0) {
                    <div class="drow pull">
                      <label>Copy details from</label>
                      <select [ngModel]="''" (ngModelChange)="pullFrom(v, $event)">
                        <option value="">Choose a version…</option>
                        @for (o of otherVariants(v); track o.id) {
                          <option [value]="o.id">{{ variantTitle(o) }}{{ o.descriptor ? ' — ' + o.descriptor : '' }}</option>
                        }
                      </select>
                    </div>
                  }

                  <app-metadata-editor
                    [metadata]="editorMeta(v)"
                    [saving]="savingId() === v.id"
                    [filenameExt]="v.format"
                    (coverChange)="onCover(v, $event)"
                    (save)="saveVariant(v, $event)" />
                </div>
              }
            </div>
          }
        }
      </div>
    }

    <!-- Generate-sentences model picker -->
    @if (pickerVariant(); as pv) {
      <div class="gs-backdrop" (click)="closeSentencePicker()">
        <div class="gs-modal" (click)="$event.stopPropagation()">
          <h3 class="gs-title">{{ pickerIsRegenerate() ? 'Regenerate sentences' : 'Generate sentences' }}</h3>
          @if (pickerIsRegenerate()) {
            <p class="gs-sub">Re-transcribe “{{ variantTitle(pv) }}”, replacing the current synced text.</p>
          } @else {
            <p class="gs-sub">Transcribe “{{ variantTitle(pv) }}” into synced on-screen text.</p>
          }

          @if (ebookVariants().length > 0) {
            <div class="gs-methods">
              <label class="gs-model gs-method" [class.sel]="pickerMethod() === 'epub-align'"
                     [class.unavail]="!alignEngineInstalled()">
                <input type="radio" name="gsmethod" value="epub-align"
                       [checked]="pickerMethod() === 'epub-align'"
                       [disabled]="!alignEngineInstalled()"
                       (change)="pickerMethod.set('epub-align')" />
                <span class="gs-mname">Use my ebook (most accurate)</span>
                @if (alignEngineInstalled()) {
                  <span class="gs-mnote">Aligns your ebook’s exact words to the narration — perfect
                    spelling, no transcription errors.</span>
                } @else {
                  <span class="gs-mnote">Needs the ebook-alignment engine — install it to enable
                    this option (also in Settings → Speech to Text).</span>
                  <span class="gs-mside">
                    @if (alignEngineInstalling(); as msg) {
                      <span class="gs-size">{{ msg }}</span>
                    } @else {
                      <button type="button" class="act gs-install"
                              (click)="installAlignEngine($event)">Install</button>
                    }
                  </span>
                }
              </label>
              <label class="gs-model gs-method" [class.sel]="pickerMethod() === 'whisper'">
                <input type="radio" name="gsmethod" value="whisper"
                       [checked]="pickerMethod() === 'whisper'"
                       (change)="pickerMethod.set('whisper')" />
                <span class="gs-mname">Transcribe from audio (Whisper)</span>
                <span class="gs-mnote">Listens to the narration and writes out the words it hears.</span>
              </label>
            </div>

            @if (pickerMethod() === 'epub-align') {
              <label class="gs-eblabel">Ebook to align</label>
              <desktop-select
                [options]="pickerEpubOptions()"
                [ngModel]="pickerEpubId()"
                (ngModelChange)="pickerEpubId.set($event)"
              />
            }
          }

          @if (pickerMethod() === 'whisper') {
            <div class="gs-models">
              @for (m of whisperModels(); track m.id) {
                <label class="gs-model" [class.sel]="pickerModelId() === m.id">
                  <input type="radio" name="gsmodel" [value]="m.id"
                         [checked]="pickerModelId() === m.id"
                         (change)="pickerModelId.set(m.id)" />
                  <span class="gs-mname">{{ m.label }}</span>
                  <span class="gs-mnote">{{ m.note }}</span>
                  <span class="gs-mside">
                    @if (m.present) {
                      <span class="gs-ok">Ready</span>
                    } @else {
                      <span class="gs-size">{{ formatMB(m.sizeMB) }} download</span>
                    }
                  </span>
                </label>
              }
            </div>

            @if (pickerNeedsDownload()) {
              <div class="gs-note">This model isn’t downloaded yet — the queued job downloads it
                first, then transcribes.</div>
            }
            @if (!whisperRuntimeInstalled()) {
              <div class="gs-note">The speech-to-text engine (~35 MB) installs automatically when
                the job runs.</div>
            }
          }

          @if (pickerIsRegenerate()) {
            <div class="gs-note">This replaces the existing synced text for this audiobook once the
              job runs. The current transcript stays in place until then.</div>
          }

          @if (pickerError(); as e) { <div class="gs-err">{{ e }}</div> }

          <div class="gs-actions">
            <button class="act" (click)="closeSentencePicker()">Cancel</button>
            <button class="act primary" (click)="startGenerateSentences(pv)"
                    [disabled]="pickerMethod() === 'whisper' ? !pickerModelId() : !pickerEpubId()">Add to queue</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* A layout component: fill the tab width as a block (don't rely on the
       browser's default inline host box wrapping its block content). */
    :host { display: block; }
    /* While comparing, the host must give the diff view a definite height —
       Studio switches the tab to full-height mode at the same time. */
    :host(.comparing) { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 12px 16px; }
    .versions { padding: 4px 2px 24px; }
    .section-head {
      display: flex; align-items: center; gap: 12px;
      font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--text-secondary);
      margin: 18px 4px 8px;
    }
    .section-head.audio { margin-top: 26px; }

    .provenance { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 4px 4px; }
    .pbadge {
      display: inline-flex; align-items: baseline; gap: 4px;
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.01em;
      color: var(--text-primary);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      padding: 3px 9px; border-radius: 999px; cursor: default;
    }
    .pbadge .pcount { font-size: 0.62rem; color: var(--text-secondary); font-weight: 700; }
    /* "Review changes" rides its badge: a pass is not a version, so this is the
       only place its recorded diff can be reached from. */
    .pbadge .preview {
      margin-left: 2px; padding: 0 2px; border: none; background: none;
      font-size: 0.62rem; font-weight: 600; letter-spacing: 0.01em;
      color: var(--accent-primary, #06b6d4); cursor: pointer; text-decoration: underline;
    }
    .pbadge .preview:hover { color: var(--text-primary); }

    .pass-err { margin: 6px 4px; font-size: 0.78rem; color: #ef4444; }

    /* A child of the archive original: the working copy, the book. Indented and
       given a rule back to the parent so the three read as one family. */
    .row.child { margin-left: 26px; position: relative; }
    .row.child::before {
      content: ''; position: absolute; left: -14px; top: 50%; width: 10px; height: 1px;
      background: var(--border-default, rgba(255,255,255,0.18));
    }

    /* The star columns: what this document has been through, derived. Unlit
       slots are shown so the row says what it COULD have and has not. */
    .stars { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 5px; }
    .star {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 0.68rem; color: var(--text-tertiary, var(--text-secondary));
      opacity: 0.55; cursor: default;
    }
    .star.lit { opacity: 1; color: var(--text-primary); font-weight: 600; }
    .star .sglyph { font-size: 0.78rem; color: var(--text-secondary); }
    .star.lit .sglyph { color: var(--accent-primary, #06b6d4); }

    /* A star with a diff behind it is a control, and looks like one: it carries
       the page's existing pill shape (see .pbadge) so it reads as pressable
       WITHOUT hovering, and it says what pressing it gets you. A lit star with no
       diff keeps the plain <span> above — the difference has to be visible, or
       the user learns that stars sometimes do nothing. */
    button.star.review {
      font-family: inherit; cursor: pointer;
      padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base);
      color: var(--text-primary); font-size: 0.68rem; font-weight: 600;
    }
    button.star.review .sgo {
      margin-left: 5px; padding-left: 6px;
      border-left: 1px solid var(--border-default, rgba(255,255,255,0.12));
      color: var(--accent-primary, #06b6d4); text-decoration: underline;
      font-weight: 600;
    }
    button.star.review:hover {
      border-color: var(--accent-primary, #06b6d4);
      background: color-mix(in srgb, var(--accent-primary, #06b6d4) 12%, var(--bg-base));
    }
    button.star.review:hover .sgo { color: var(--text-primary); }
    button.star.review:focus-visible {
      outline: 2px solid var(--accent-primary, #06b6d4); outline-offset: 2px;
    }

    /* Said in words, where the eye lands — a tooltip is only found by someone who
       already suspected the star did something. Rendered only when at least one
       star on THIS row is pressable, so the page never advertises an affordance
       that isn't there. */
    .stars-hint { margin-top: 4px; font-size: 0.68rem; color: var(--text-secondary); }

    /* Said, not locked: the book is older than the curation, and Rebuild is
       right there. Nothing is disabled by it. */
    .stale { margin-top: 5px; font-size: 0.7rem; color: var(--warning, #f59e0b); }
    /* Footnote removal's own review report, above the diff it belongs to. */
    .pass-report {
      margin: 0 4px 10px; padding: 8px 12px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.1));
      background: var(--bg-elevated); color: var(--text-secondary);
      font-size: 0.76rem; line-height: 1.45;
    }
    .compare-when { font-size: 0.76rem; color: var(--text-secondary); margin-left: auto; }

    .section-head .add-version {
      margin-left: auto; text-transform: none; letter-spacing: 0;
      font-size: 0.78rem; font-weight: 600;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
      padding: 4px 10px; border-radius: 6px; cursor: pointer;
    }
    .section-head .add-version:hover:not(:disabled) { background: var(--bg-elevated); }
    .section-head .add-version:disabled { opacity: 0.5; cursor: default; }

    .section-head .start-over {
      margin-left: auto; text-transform: none; letter-spacing: 0;
      font-size: 0.78rem; font-weight: 600;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
      padding: 4px 10px; border-radius: 6px; cursor: pointer;
    }
    .section-head .start-over:hover:not(:disabled) {
      background: color-mix(in srgb, #ef4444 20%, var(--bg-base)); border-color: #ef4444;
    }
    .section-head .start-over:disabled { opacity: 0.5; cursor: default; }

    .vzone {
      border: 1px dashed transparent; border-radius: 10px; padding: 2px;
      transition: border-color 0.15s, background 0.15s;
    }
    .vzone.dragover {
      border-color: var(--accent-primary, #06b6d4);
      background: color-mix(in srgb, var(--accent-primary, #06b6d4) 8%, transparent);
    }
    .vempty {
      color: var(--text-secondary); font-size: 0.82rem; line-height: 1.5;
      padding: 18px 16px; text-align: center;
      border: 1px dashed var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px;
    }
    /* Inline determinate bar while an added audio file transcodes to M4B. */
    .vconvert {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; margin-bottom: 8px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      background: var(--bg-elevated); font-size: 0.78rem;
    }
    .vc-label { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vc-bar { flex: 1; height: 6px; background: var(--bg-base); border-radius: 3px; overflow: hidden; }
    .vc-fill { height: 100%; background: var(--accent-primary, #06b6d4); transition: width 0.2s ease; }
    .vc-pct { color: var(--text-secondary); min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    .vrow {
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      border-radius: 8px; margin-bottom: 8px; background: var(--bg-elevated);
      overflow: hidden;
    }
    .vrow.open { border-color: var(--accent-primary, #06b6d4); }
    .vhead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; cursor: pointer; }
    .badge {
      font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      color: #fff; background: var(--accent-primary, #06b6d4);
      padding: 1px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle;
    }
    .veditor { padding: 4px 14px 16px; border-top: 1px solid var(--border-default, rgba(255,255,255,0.07)); }
    .drow { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
    .drow label {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em;
      color: var(--text-secondary);
    }
    .drow input, .drow select {
      padding: 0.5rem 0.75rem; background: var(--bg-subtle, var(--bg-base));
      border: 1px solid var(--border-default); border-radius: 6px;
      color: var(--text-primary); font-size: 0.875rem;
    }
    .drow input:focus, .drow select:focus { outline: none; border-color: var(--accent-primary); }
    .drow .dhint { font-size: 0.68rem; color: var(--text-muted, var(--text-secondary)); }
    .drow.pull select { max-width: 340px; cursor: pointer; }

    .row {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      margin-bottom: 8px; background: var(--bg-elevated);
    }
    .row.dim { opacity: 0.4; }
    .row.clickable { cursor: pointer; }
    .row.clickable:hover { border-color: var(--accent-primary, #06b6d4); }
    .ricon { font-size: 1.3rem; flex-shrink: 0; }
    /* Grows to fill, but keeps a sane basis so the actions can wrap to their own
       line (below the title) instead of pushing off-screen on narrow windows. */
    .rinfo { flex: 1 1 240px; min-width: 0; }
    .rlabel { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); }
    .ext { font-size: 0.72rem; color: var(--text-secondary); font-weight: 400; }
    .rdesc { font-size: 0.74rem; color: var(--text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Filename wraps (word-break) rather than truncating, so the extension — the
       whole point of showing it — is never hidden behind an ellipsis. */
    .rfile { font-size: 0.7rem; color: var(--text-secondary); margin-top: 3px; font-family: var(--font-mono, ui-monospace, monospace); opacity: 0.85; word-break: break-all; }
    .narrator {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 5px;
      padding: 2px 8px; border-radius: 5px; font-size: 0.72rem; color: var(--text-primary);
      background: var(--bg-base); border: 1px solid var(--border-default, rgba(255,255,255,0.1));
    }
    .narrator .nlabel {
      font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-secondary);
    }
    /* Actions: a right-aligned cluster of the row's own buttons. margin-left:auto
       pushes it to the row's right edge, so every row's buttons end at the same
       right edge (they line up). Each row shows only the buttons it actually has —
       no fixed-width columns and no invisible <span.slot> spacers, which used to
       reserve ~480px in every row (making sparse rows float mid-panel and forcing
       the whole cluster off the panel when it was narrower than that reserve).
       flex-wrap lets the buttons drop to a second line WITHIN the row when the
       panel is genuinely too narrow, instead of spilling off the edge. */
    .ractions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: flex-end; margin-left: auto; }
    .ractions .specials { display: flex; gap: 6px; margin-right: 4px; }
    .ractions .specials:empty { display: none; margin: 0; }
    .act {
      box-sizing: border-box;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
      padding: 5px 11px; border-radius: 6px; font-size: 0.78rem; line-height: 1.2;
      cursor: pointer; white-space: nowrap;
    }
    .act:hover:not(:disabled) { background: var(--bg-elevated); }
    .act:disabled { opacity: 0.45; cursor: default; }
    .act.primary { background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff; }
    .act.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-primary, #06b6d4) 85%, #fff); }
    .act.danger:hover:not(:disabled) { background: color-mix(in srgb, #ef4444 20%, var(--bg-base)); border-color: #ef4444; }
    .muted { color: var(--text-secondary); padding: 12px 4px; font-size: 0.85rem; }
    .compare-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .compare-bar { display: flex; align-items: center; gap: 14px; padding: 8px 4px 12px; }
    .compare-bar .back { background: none; border: 1px solid var(--border-default); color: var(--text-primary); padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
    .compare-title { font-size: 0.85rem; font-weight: 600; }
    .compare-title .vs { color: var(--text-secondary); font-weight: 400; margin: 0 4px; }
    /* No 'display' here: the parent's 'app-diff-view' selector (0,1,1) would
       override diff-view's own :host { display: flex } (0,1,0), forcing the host
       to block. That collapses the diff-view's internal flex height chain so
       .chapter-content never gets a bounded height and can't scroll. Let the
       component set its own display:flex; we only make it a fill flex item. */
    app-diff-view { flex: 1; min-height: 0; }

    /* Generate-sentences picker */
    .gs-backdrop {
      position: fixed; inset: 0; z-index: 400;
      background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .gs-modal {
      width: min(560px, 100%); max-height: 80vh; overflow: auto;
      background: var(--bg-surface, var(--bg-elevated)); color: var(--text-primary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 12px; padding: 20px 22px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    }
    .gs-title { margin: 0 0 4px 0; font-size: 1.05rem; font-weight: 700; }
    .gs-sub { margin: 0 0 16px 0; font-size: 0.82rem; color: var(--text-secondary); }
    .gs-runtime { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
    .gs-runtime p { margin: 0; font-size: 0.85rem; color: var(--text-secondary); }
    .gs-methods { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .gs-method { grid-template-columns: auto 1fr auto; }
    .gs-method .gs-mnote { grid-column: 2; }
    /* Engine-missing state: mute the option (radio is disabled) but keep the
       inline Install affordance at full strength. */
    .gs-method.unavail { cursor: default; }
    .gs-method.unavail .gs-mname, .gs-method.unavail .gs-mnote { opacity: 0.55; }
    .gs-install { padding: 4px 12px; font-size: 0.75rem; }
    .gs-eblabel { display: block; font-size: 0.78rem; font-weight: 600; margin: 0 0 6px 2px; }
    .gs-models { display: flex; flex-direction: column; gap: 8px; }
    .gs-model {
      display: grid; grid-template-columns: auto 1fr auto; align-items: center;
      gap: 4px 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--border-default, rgba(255,255,255,0.1)); background: var(--bg-base);
    }
    .gs-model.sel { border-color: var(--accent-primary, #06b6d4); }
    .gs-model input { grid-row: span 2; }
    .gs-mname { font-size: 0.86rem; font-weight: 600; }
    .gs-mnote { grid-column: 2; font-size: 0.72rem; color: var(--text-secondary); }
    .gs-mside { grid-column: 3; grid-row: span 2; display: flex; align-items: center; }
    .gs-ok { font-size: 0.72rem; color: var(--success, #22c55e); font-weight: 600; }
    .gs-size { font-size: 0.72rem; color: var(--text-secondary); white-space: nowrap; }
    .gs-note { margin-top: 12px; font-size: 0.75rem; color: var(--text-secondary); line-height: 1.45; }
    .gs-err { margin-top: 12px; font-size: 0.78rem; color: #ef4444; }
    .gs-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `]
})
export class StudioVersionsComponent {
  private readonly electron = inject(ElectronService);
  private readonly components = inject(ComponentService);
  private readonly queue = inject(QueueService);
  private readonly imports = inject(VariantImportService);

  readonly projectDir = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);

  readonly edit = output<string>();          // working-file path -> open editor (with project state)
  readonly open = output<string>();         // book-variant abs path -> open standalone in the editor
  readonly exportDoc = output<string>();    // version path -> export EPUB/PDF
  readonly exportAudio = output<string>();  // abs path of the audiobook variant -> export the M4B
  readonly listen = output<string>();       // abs path of the audiobook variant to play
  readonly skipped = output<void>();
  readonly continueJob = output<void>();    // resume the partial render (routes to the Processing wizard)
  readonly assemble = output<void>();       // assemble the cached sentences (routes to the Processing wizard)
  readonly correctSentences = output<void>(); // regenerate individual bad sentences, then rebuild
  readonly changed = output<void>();        // after delete/edit -> tell Studio to refresh
  readonly compareActive = output<boolean>(); // Studio goes full-height while comparing
  readonly viewAnalysis = output<{ path: string }>();  // open this version's file with analysis flags highlighted
  readonly generateAnalysis = output<StudioAnalysisTarget>(); // opens the analysis modal, locked to this source

  readonly versions = signal<VersionRow[]>([]);
  readonly loading = signal(false);
  readonly cache = signal<SentenceCacheInfo | null>(null);
  // The TTS voice that rendered this project's audio (from the durable session's
  // provenance), used as the narrator for TTS audiobooks that have no explicit one.
  readonly ttsVoice = signal<string | null>(null);
  /**
   * What the tab is showing instead of the version list.
   *
   * Two shapes, because there are two genuinely different comparisons. `paths`
   * compares two FILES that both exist (the original against a derived EPUB).
   * `pass` opens ONE pass's recorded diff: the pass rewrote the book in place, so
   * neither side of it exists as a file any more and the diff carries both texts.
   * Read through comparePaths()/comparePass() so each branch of the template gets
   * the narrowed shape rather than the union.
   */
  readonly comparing = signal<
    | { mode: 'paths'; a: string; b: string; labelA: string; labelB: string }
    | { mode: 'pass'; diffPath: string; reportPath: string; title: string; when: string }
    | null
  >(null);
  readonly comparePaths = computed(() => {
    const c = this.comparing();
    return c && c.mode === 'paths' ? c : null;
  });
  readonly comparePass = computed(() => {
    const c = this.comparing();
    return c && c.mode === 'pass' ? c : null;
  });

  // Book variants (editions/languages/formats). Rows arrive with their file path
  // ALREADY RESOLVED by main — this component never joins a project directory onto
  // a variant's relative path (see ResolvedProjectVariant and loadedForProjectDir).
  readonly variantList = signal<ResolvedProjectVariant[]>([]);
  readonly transcriptEligibleVariantIds = signal<Set<string>>(new Set());
  readonly transcriptEligibilityKnown = signal(false);
  private variantLoadGeneration = 0;
  /**
   * Which project's load() is allowed to publish rows. Bumped on entry to load();
   * a load whose generation has been superseded must not write ANY of the signals
   * it was going to write, because a newer load for a DIFFERENT book already owns
   * them. Mirrors variantLoadGeneration one level up.
   */
  private loadGeneration = 0;
  /**
   * The projectDir the rows currently in `versions` + `variantList` were loaded FOR.
   *
   * The rows and the selected book are updated at different times: `projectDir` is an
   * input that flips the instant the user picks another book, while the rows only
   * catch up after two async IPC round-trips. Recording what the DISPLAYED rows
   * belong to is what lets load() tell "reload the same book" (where keeping the
   * old rows through a failed read is right) apart from "different book entirely"
   * (where every displayed row is now meaningless and must go immediately).
   */
  private readonly loadedForProjectDir = signal<string | null>(null);
  readonly primaryId = signal<string | undefined>(undefined);
  readonly openId = signal<string | null>(null);
  readonly savingId = signal<string | null>(null);
  // Add-in-flight state is keyed by project id and OWNED BY VariantImportService,
  // not by this component: the user can switch books (or tabs, which destroys and
  // re-creates this component) while an import runs, and the bar must still be
  // right when they come back. busy()/importProgress() resolve to the
  // CURRENTLY-shown project's slice of that shared per-project state.
  readonly busy = computed(() => this.imports.busyPids().has(this.projectId()));
  /** Live 0..1 transcode progress for the audio file variant:add is converting. */
  readonly importProgress = computed(() => this.imports.progressByPid()[this.projectId()] ?? null);
  readonly vDragOver = signal(false);
  private vDragCounter = 0;
  private readonly pendingCover = signal<Record<string, string>>({});
  readonly descriptorDraft = signal<Record<string, string>>({});
  // A STABLE EpubMetadata reference per open variant. The metadata-editor resets
  // its form whenever this input's reference changes, so we build it once when the
  // editor opens (after the cover loads) and never rebuild it while the user types.
  private readonly editorMetaCache = signal<Record<string, EpubMetadata>>({});

  readonly variants = computed(() => this.variantList());

  /**
   * Book versions section: the reading editions only (ebooks), and only the ones
   * the family above is not already showing.
   *
   * A project's archive original is BOTH a manifest variant and the family's
   * parent, so listing it in each put the same file on screen twice under two
   * different names — which reads as two files, and invites the user to wonder
   * which one their edits went to. The family is the authority for the
   * documents this pipeline produces; this section is what is left, which is
   * what "other editions of this book" always meant.
   *
   * Compared by absolute path because that is the only thing the two lists
   * share: one is built from the manifest's variant records, the other from the
   * binding record and the files on disk, and neither carries the other's ids.
   */
  readonly ebookVariants = computed(() => {
    const shown = new Set(
      this.documents()
        .map(d => d.path?.toLowerCase())
        .filter((p): p is string => !!p));
    return this.variantList().filter(v =>
      v.kind === 'ebook' && !shown.has(v.absPath.toLowerCase()));
  });

  /** Audio section: the audiobook editions — the single home for every M4B,
   *  whether uploaded via "+ Add version" or produced by TTS. */
  readonly audiobookVariants = computed(() => this.variantList().filter(v => v.kind === 'audiobook'));

  readonly documents = computed(() => this.versions().filter(v => v.type !== 'analysis'));

  // ── The document family ────────────────────────────────────────────────────

  /**
   * What this book HAS, as the family derivation needs it — read off the rows
   * main measured, never off anything this component remembers.
   *
   * The three members are found by TYPE rather than by position or by name: the
   * types are `editor:get-versions`'s contract, and a row that is not there means
   * the file is not there.
   */
  private readonly familyInput = computed<VersionFamilyInput>(() => {
    const docs = this.documents();
    const of = (type: string): VersionRow | null => docs.find(v => v.type === type) ?? null;

    const archiveRow = of('archive');
    const workingRow = of('working');
    const epubRow = of('exported');

    // Every 'working' row main emits carries its boundaries (possibly an empty
    // list). One without them is IPC shape drift, not a working copy that has
    // been through no stages — so it is reported and left out of the family
    // rather than silently shown with no stars. The row itself still appears;
    // rowDescription() says what could not be read.
    if (workingRow && !workingRow.stageBoundaries) {
      console.error(
        `[studio-versions] the working-copy row for ${workingRow.path} arrived without its stage `
        + 'boundaries. editor:get-versions sets them on every working row it emits, so this build '
        + 'of the renderer and the main process disagree about the row shape.');
    }

    return {
      archive: archiveRow ? { id: archiveRow.id } : null,
      working: workingRow && workingRow.stageBoundaries
        ? {
          id: workingRow.id,
          boundaries: workingRow.stageBoundaries,
          // The working document's mtime: curation lands as an append to this
          // file, so this is the measurement of when it was last edited.
          modifiedAt: workingRow.modifiedAt ?? null,
        }
        : null,
      epub: epubRow ? { id: epubRow.id, builtAt: epubRow.builtAt ?? null } : null,
      appliedPasses: this.item()?.appliedPasses ?? [],
    };
  });

  /**
   * The rows as the page shows them: the family first, in ladder order, then
   * whatever else this project carries.
   *
   * Depth and stars come from the shared derivation
   * (`@shared/document/version-family`) rather than from anything decided here,
   * which is what keeps "the archive can never earn a star" true by
   * construction instead of by care.
   */
  readonly documentRows = computed<DocumentFamilyRow[]>(() => {
    const input = this.familyInput();
    const family = new Map(versionFamily(input).map(r => [r.id, r]));
    const reviews = this.reviewByStar();
    const ladder = ['archive', 'working', 'exported'];
    const rank = (v: VersionRow): number => {
      const at = ladder.indexOf(v.type);
      // Everything outside the family (legacy stage outputs, the old source/
      // original) keeps its own order, after the family.
      return at === -1 ? ladder.length : at;
    };

    return [...this.documents()]
      .map((v, index) => ({ v, index }))
      .sort((a, b) => (rank(a.v) - rank(b.v)) || (a.index - b.index))
      .map(({ v }) => {
        const member = family.get(v.id);
        if (!member) return { v, depth: 0 as const, slots: [], staleness: null };
        const lit = new Set<VersionStar>(member.stars);
        return {
          v,
          depth: member.depth,
          slots: starSlotsFor(member.kind).map(id => {
            // A review only ever hangs off a LIT star: the diff is the record of
            // a run, and an unlit star is the absence of one. A lit star with no
            // diff (the pass ran, its job died before recording, or it predates
            // diffs) keeps `review: null` and stays inert.
            const review = lit.has(id) ? reviews.get(id) ?? null : null;
            return {
              id,
              label: STAR_LABELS[id],
              lit: lit.has(id),
              tooltip: lit.has(id)
                ? STAR_MEANINGS[id]
                : `Not done: ${STAR_MEANINGS[id].charAt(0).toLowerCase()}${STAR_MEANINGS[id].slice(1)}`,
              review,
              action: review
                ? `See what ${STAR_LABELS[id].toLowerCase()} changed in this file — ${review.when}`
                : null,
            };
          }),
          staleness: member.staleness,
        };
      });
  });

  /**
   * The latest recorded diff for each star, keyed by the star it lights.
   *
   * `passDiffs()` is the manifest's own index of the passes that left a diff, in
   * execution order, so the LAST of a kind is the one that describes the book —
   * the same latest-wins the badges use. `starForPassKind` is the one mapping
   * from a pass kind to a star (@shared/document/version-family), so a kind with
   * no star column (get-text, blocks, reflow, and the retired kinds) simply does
   * not appear here and its review stays on its badge.
   */
  private readonly reviewByStar = computed(() => {
    const byStar = new Map<VersionStar, { diffPath: string; reportPath: string; kind: AppliedPassKind; when: string }>();
    for (const diff of this.passDiffs()) {
      const star = starForPassKind(diff.kind);
      if (!star) continue;
      const at = new Date(diff.at);
      byStar.set(star, {
        diffPath: diff.absPath,
        // Footnote removal writes foundry's own review report beside its diff.
        // Other passes have none, and a missing file shows no header.
        reportPath: diff.absPath.replace(/diff\.json$/, 'report.json'),
        kind: diff.kind,
        when: isNaN(+at) ? 'date unknown' : at.toLocaleString(),
      });
    }
    return byStar;
  });

  /**
   * Is the book's own row on screen?
   *
   * Measured from the family, which mints an EPUB row exactly when the file is
   * on disk. False is a real state — a record naming a book somebody removed by
   * hand — and it is what decides whether the stars can carry the reviews.
   */
  private readonly epubRowPresent = computed(() =>
    this.documents().some(v => v.type === 'exported'));

  /** True when at least one star on this row can be pressed. Drives the hint. */
  rowHasReviewableStar(row: DocumentFamilyRow): boolean {
    return row.slots.some(s => !!s.review);
  }

  /**
   * Open what a pass changed, from its star.
   *
   * The SAME viewer and the same report loading as the provenance badge's
   * "Review changes" — one way to show a pass diff, reached from wherever the
   * record of that pass is shown.
   */
  openStarReview(slot: StarSlot): void {
    const review = slot.review;
    if (!review) {
      console.error(`[studio-versions] the ${slot.id} star was pressed with no recorded diff behind `
        + 'it. Only a star carrying a review is rendered as a button.');
      return;
    }
    this.passReport.set(null);
    this.comparing.set({
      mode: 'pass',
      diffPath: review.diffPath,
      reportPath: review.reportPath,
      title: `${STAR_LABELS[slot.id]} — what changed`,
      when: review.when,
    });
    this.compareActive.emit(true);
    if (review.kind === 'footnotes') void this.loadPassReport(review.reportPath);
  }

  /** What a stage boundary is called on the working copy's line. */
  private readonly BOUNDARY_LABELS: Record<string, string> = {
    'get-text': 'Cast',
    blocks: 'Blocks detected',
    footnotes: 'Footnotes removed',
  };

  /**
   * The row's own sentence: what it is, what has landed on it and when, and how
   * big it is.
   *
   * The working copy's stages are spelled out with their dates because "what has
   * happened to this file" is exactly the question the missing row left the user
   * unable to answer.
   */
  rowDescription(row: DocumentFamilyRow): string {
    const v = row.v;
    const parts: string[] = [v.description];

    if (v.type === 'working') {
      const boundaries = v.stageBoundaries;
      if (!boundaries) {
        parts.push('BookForge could not read which stages have landed on it — see the console');
      } else if (boundaries.length === 0) {
        parts.push('no stage has finished on it yet');
      } else {
        parts.push(boundaries
          .map(b => `${this.BOUNDARY_LABELS[b.stage] ?? b.stage} ${this.fmtDate(b.finishedAt)}`)
          .join(' · '));
      }
    }

    if (v.fileSize) parts.push(this.fmtSize(v.fileSize));
    if (v.modifiedAt) parts.push(this.fmtDate(v.modifiedAt));
    return parts.filter(Boolean).join(' · ');
  }

  /**
   * The file the editor is pointed at for this row.
   *
   * `openPath` is set only where the row's own file is NOT what should open —
   * the working copy, a hidden sidecar that standalone would carry no project,
   * no binding and no annotations. Its absence is the ordinary case ("open this
   * row's file"), which is why this is a branch rather than a default.
   */
  private editorTargetFor(v: VersionRow): string {
    return v.openPath ? v.openPath : v.path;
  }

  openDoc(v: VersionRow): void { this.edit.emit(this.editorTargetFor(v)); }

  openTitle(v: VersionRow): string {
    if (v.type === 'working') return 'Open this book in the picker, on your working copy';
    if (v.type === 'archive') {
      return 'Opening this book lands on your working copy — the row below. You never start on a '
        + 'read-only original, so there is nothing separate to open here.';
    }
    return 'Open this file in the editor';
  }

  /**
   * Every document row exports. What differs is what an export IS.
   *
   * Owen, third session: "the archive and working pdf are missing their buttons
   * on the version page. export, open, delete." The working copy used to be the
   * one row without an Export, on the reasoning that it is the system's document
   * rather than a deliverable. That was a judgement about what the user should
   * want; the file is theirs, it is the only artifact carrying their curation as
   * a readable PDF, and "give me a copy of it" is a request the app has no
   * standing to refuse.
   *
   * Export never writes into the project — least of all into archive/, which is
   * only ever READ here. The copy goes where the user pointed the save dialog.
   */
  exportable(_v: VersionRow): boolean { return true; }

  exportTitle(v: VersionRow): string {
    if (v.type === 'archive') return 'Save a copy of the untouched original to your computer';
    if (v.type === 'working') {
      return 'Save a copy of your working PDF — the cast text and your block curation — to your computer';
    }
    return 'Save a copy to your computer';
  }

  // ── Rebuild (staleness is said, never locked) ──────────────────────────────

  readonly rebuilding = signal(false);

  /**
   * Build the book again from the working copy as it stands now.
   *
   * Queued through the SAME entry point every other pass run uses, so nothing
   * here assembles a job: main plans it, the queue runs it, and the user can
   * watch it where they watch everything else.
   */
  async rebuildBook(): Promise<void> {
    const dir = this.projectDir();
    if (!dir || this.rebuilding()) return;
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Rebuild the book',
      message: 'Build the book again from your working copy?',
      detail: 'The new book is written from the working copy as it stands now, so it includes the '
        + 'curation you have done since the last build.\n\nIt is a FRESH book: the passes applied to '
        + 'the old one — footnote removal, simplify, translate — are not carried over, and their '
        + 'stars clear.',
      confirmLabel: 'Rebuild', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    this.rebuilding.set(true);
    try {
      const res = await this.queue.submitProcessingRun({ projectDir: dir, passes: [{ kind: 'reflow' }] });
      if (!res.success) {
        await this.electron.showMessageDialog({
          title: 'Could not rebuild the book',
          message: res.error || 'The rebuild was refused and gave no reason.',
          type: 'error',
        });
        return;
      }
      await this.electron.showMessageDialog({
        title: 'Added to queue',
        message: 'Rebuilding the book was added to the queue. Open the Queue tab and press Start to run it.',
        type: 'info',
      });
    } finally {
      this.rebuilding.set(false);
    }
  }

  // ── Provenance ─────────────────────────────────────────────────────────────

  /**
   * What has been done to the book EPUB, as one badge per pass KIND.
   *
   * Read off `item().appliedPasses`, which the Studio loader already has: the
   * manifest is opened once for the whole library, and re-opening it here to
   * answer a question already answered would put a second reader on a record
   * that changes underneath it.
   *
   * The passes rewrite the book IN PLACE, so the file itself cannot say what was
   * done to it — this record is the only answer, and a book with no record is a
   * book nothing has run against. Hence no "unknown" or "probably cleaned"
   * badge: absence is a fact here, not a gap.
   */
  readonly provenanceBadges = computed<ProvenanceBadge[]>(() => {
    const passes = this.item()?.appliedPasses ?? [];
    const order: AppliedPassKind[] = [
      'tesseract', 'ocr-correction', 'detection', 'footnotes', 'simplify', 'translate'];
    // ONE latest-wins implementation, shared with the stars on the document rows
    // (@shared/document/version-family). Two collapses of the same list is how
    // one panel comes to say two things about one pass.
    const collapsed = latestPassByKind(passes);
    const diffs = this.passDiffs();

    return order.flatMap((kind) => {
      const entry = collapsed.get(kind);
      if (!entry) return [];
      const latest = entry.latest;
      const detail = this.passParamSummary(latest);
      const at = new Date(latest.at);
      const when = isNaN(+at) ? 'date unknown' : at.toLocaleString();
      // The diffs for this kind, in execution order — so the last is the latest.
      // A pass whose job died halfway recorded nothing, so a kind with runs but
      // no diff is a real state and the badge simply carries no review.
      // Which door this pass's diff is behind.
      //
      // The STAR on the book's row is the way in (Owen, third session: the diff
      // "should be linked to the file it was applied to"), so a kind that has a
      // star column does not also offer "Review changes" here — two controls
      // opening one diff is the duplication the stars exist to remove. Two kinds
      // have no star column and would otherwise be unreachable: the retired
      // `tesseract` and `detection` of books processed before Aug 2026. And when
      // the book row is NOT on screen at all — its file removed from under the
      // record — there is no star to carry any of them, so the badge takes them
      // all back rather than stranding a diff the user can still read.
      const carriedByStar = !!starForPassKind(kind) && this.epubRowPresent();
      const ofKind = carriedByStar ? [] : diffs.filter(d => d.kind === kind);
      const latestDiff = ofKind.length > 0 ? ofKind[ofKind.length - 1] : null;
      const many = entry.count > 1
        ? ` (ran ${entry.count} times; this is the last${ofKind.length > 1 ? ', and Review changes opens its diff' : ''})`
        : '';
      return [{
        kind,
        label: PASS_LABELS[kind],
        count: entry.count,
        tooltip: `${PASS_LABELS[kind]} — ${when}${detail ? ` · ${detail}` : ''}${many}`,
        review: latestDiff
          ? {
            diffPath: latestDiff.absPath,
            // Footnote removal writes foundry's own review report beside its
            // diff. Other passes have none, and a missing file shows no header.
            reportPath: latestDiff.absPath.replace(/diff\.json$/, 'report.json'),
            when: (() => {
              const d = new Date(latestDiff.at);
              return isNaN(+d) ? 'date unknown' : d.toLocaleString();
            })(),
          }
          : null,
      }];
    });
  });

  /** The params worth putting in a tooltip, per kind. Free-form JSON otherwise. */
  private passParamSummary(pass: AppliedPass): string {
    const p = pass.params ?? {};
    const str = (k: string): string | undefined =>
      typeof p[k] === 'string' && p[k] ? (p[k] as string) : undefined;

    switch (pass.kind) {
      case 'translate': {
        const langs = str('from') && str('to') ? `${str('from')}→${str('to')}` : undefined;
        return [langs, str('model')].filter(Boolean).join(' · ');
      }
      case 'simplify':
        return [str('mode'), str('model')].filter(Boolean).join(' · ');
      case 'ocr-correction':
        // `blocksModel` is read as well as `ocrModel` because a book processed
        // before the two passes split records both under this one kind.
        return [str('ocrModel'), str('blocksModel')].filter(Boolean).join(' · ');
      case 'detection':
        return str('blocksModel') ?? '';
      case 'footnotes':
        return str('model') ?? '';
      case 'tesseract':
        // Pinned: one version, one tessdata, 200 dpi. Nothing to report.
        return '';
      default:
        return '';
    }
  }

  // ── Pass diffs (Review Changes for the processing passes) ──────────────────

  /** The passes of this book that left a diff, newest last. From the manifest. */
  readonly passDiffs = signal<PassDiffEntry[]>([]);
  readonly passDiffError = signal<string | null>(null);

  /**
   * Why the version list on screen may not be what is on disk, or null.
   *
   * A failed read deliberately KEEPS the rows (a transient manifest lock on a
   * synced drive must not make a book's versions appear to vanish), which means
   * the failure has to be said somewhere or it is invisible. It is now reachable
   * from a new source: a binding record that is present and will not parse
   * refuses the whole listing rather than answering "this book has no working
   * copy" — which would send the user to re-cast a document that already exists.
   */
  readonly versionsError = signal<string | null>(null);
  /** Footnote removal's own review report, when the open pass diff has one. */
  readonly passReport = signal<{ summary: string; detail: string } | null>(null);

  /** Open the LATEST run of this pass kind in the Review Changes viewer. */
  startPassCompare(badge: ProvenanceBadge): void {
    const review = badge.review;
    // The button only exists when there is a review, so no review here is a
    // template/logic divergence rather than an ordinary state — say so.
    if (!review) {
      console.error(`[studio-versions] "Review changes" was pressed on the ${badge.kind} badge, `
        + 'which has no recorded diff. The button should not have been rendered.');
      return;
    }
    this.passReport.set(null);
    this.comparing.set({
      mode: 'pass',
      diffPath: review.diffPath,
      reportPath: review.reportPath,
      title: `${badge.label} — what changed`,
      when: review.when,
    });
    this.compareActive.emit(true);
    if (badge.kind === 'footnotes') void this.loadPassReport(review.reportPath);
  }

  /**
   * The footnotes pass's `report.json`, summarised for the header above its diff.
   *
   * Optional by nature: only footnote removal writes one, and only in EPUB mode.
   * A file that is not there means "no report", which is why this reads it
   * directly and shows nothing when it comes back empty — the diff below is the
   * real content, and a missing sidecar must not stand between the user and it.
   * A file that IS there but is not readable JSON is a broken artifact, and says so.
   */
  private async loadPassReport(reportPath: string): Promise<void> {
    const text = await this.electron.readTextFile(reportPath);
    if (!text) return;
    try {
      const rep = JSON.parse(text) as FootnotesReport;
      const t = rep.totals;
      if (!t) return;
      const summary = `${t.deletionsApplied} footnote marker${t.deletionsApplied === 1 ? '' : 's'} removed`
        + ` across ${t.documentsEdited} of ${t.documents} document${t.documents === 1 ? '' : 's'}`
        + (t.deletionsRejected ? ` · ${t.deletionsRejected} proposal(s) rejected` : '')
        + (rep.model ? ` · ${rep.model}` : '');
      const detail = `${t.unitsAsked} text unit(s) asked, ${t.unitsFired} changed`
        + `; ${t.unitsNoteBody} note bodies and ${t.unitsIndex} index entries skipped`
        + `${rep.askEverything ? ' (ask-everything was on)' : ''}`;
      this.passReport.set({ summary, detail });
    } catch (err) {
      this.passReport.set({
        summary: `The footnote report beside this diff could not be read: ${(err as Error).message}`,
        detail: reportPath,
      });
    }
  }

  // ── Content analysis (one report per book, pinned to a specific version) ────
  /** The synthetic 'analysis' row from editor:get-versions, if a report exists. */
  readonly analysisEntry = computed(() => this.versions().find(v => v.type === 'analysis') ?? null);
  /** The durable version id the report is pinned to (null when orphaned). */
  readonly analysisTargetId = computed(() => this.analysisEntry()?.analysisTarget?.versionId ?? null);

  /** One-line summary for the Analysis item: flag count + which version it's pinned to. */
  analysisRowDesc(a: VersionRow): string {
    const flags = a.analysisFlagCount ?? 0;
    const t = a.analysisTarget;
    const attached = t?.versionId
      ? `on ${t.versionLabel || 'a version'}`
      : 'analyzed version no longer available';
    const parts = [`${flags} flag${flags !== 1 ? 's' : ''} · ${attached}`];
    if (a.modifiedAt) parts.push(this.fmtDate(a.modifiedAt));
    return parts.join(' · ');
  }

  /** Re-run the analysis on the same version it's currently pinned to. */
  regenerateAnalysis(a: VersionRow): void {
    const t = a.analysisTarget;
    if (!t || !t.versionId) return; // orphaned report — nothing to re-target
    this.generateAnalysis.emit({
      kind: 'document', projectId: this.projectId(),
      versionId: t.versionId, versionType: t.versionType, versionLabel: t.versionLabel,
      path: a.path,
    });
  }

  /** True if a text version can be analyzed — only EPUBs (analysis extracts EPUB chapters). */
  canAnalyzeVariant(v: ProjectVariant): boolean {
    if (v.kind !== 'ebook') return false;
    const ext = ((v.format || '') || this.variantFilename(v).split('.').pop() || '').toLowerCase();
    return ext === 'epub';
  }
  variantIsAnalysisTarget(v: ProjectVariant): boolean {
    const id = this.analysisTargetId();
    return !!id && v.id === id;
  }
  docIsAnalysisTarget(v: VersionRow): boolean {
    const id = this.analysisTargetId();
    return !!id && v.id === id;
  }

  async emitGenerateAnalysisVariant(v: ResolvedProjectVariant): Promise<void> {
    // The analysis job reads this exact file; queueing it against a path that isn't
    // there would only fail later, in the queue, away from the click that caused it.
    const abs = await this.variantFile(v, 'analyze this version');
    if (!abs) return;
    this.generateAnalysis.emit({
      kind: 'document', projectId: this.projectId(),
      versionId: v.id, versionType: v.kind, versionLabel: this.variantTitle(v),
      path: abs,
    });
  }
  emitGenerateAnalysisDoc(v: VersionRow): void {
    this.generateAnalysis.emit({
      kind: 'document', projectId: this.projectId(),
      versionId: v.id, versionType: v.type, versionLabel: v.label, path: v.path,
    });
  }

  emitGenerateAudiobookAnalysis(v: ProjectVariant): void {
    this.generateAnalysis.emit({
      kind: 'audiobook', projectId: this.projectId(), variantId: v.id,
      versionLabel: this.variantTitle(v),
    });
  }

  /** Delete the whole content-analysis report (report + checkpoint) for this book. */
  async removeAnalysis(): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete analysis',
      message: 'Delete the content-analysis report for this book? This cannot be undone.',
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const res = await this.electron.deleteAnalysis(dir);
    if (res.success) { await this.load(); this.changed.emit(); }
  }

  constructor() {
    // Only react to project/refresh changes. load() reads comparing() (to close an
    // open compare on item switch); without untracked() that read makes this effect
    // depend on comparing, so starting a compare would instantly re-run load() and
    // close it again — the compare view would never appear.
    effect(() => {
      this.projectDir();
      this.refreshTrigger();
      untracked(() => void this.load());
    });

    // A new artifact appears the moment it exists.
    //
    // Owen, second real session 2026-08-04: "i reflowed the file but i dont see
    // it listed in versions… there — it appeared. it should appear immediately."
    // The parent's `project:files-changed` listener was the only thing bumping
    // `refreshTrigger`, and the QUEUE path never sends it: `withDocumentStage`
    // (electron/processing-passes.ts) broadcasts stage-started/progress/finished
    // and nothing else, so a backgrounded reflow wrote a book that this page had
    // no way of hearing about. `document:stage-finished` IS broadcast by both
    // producers, to every window, from a `finally` — so it is what to listen to.
    //
    // It re-runs the SAME load(), which measures the project folder and the
    // binding record. Nothing about the event is believed except that something
    // happened to this project: the stage name is not consulted, no row is
    // synthesized from it, and a stage that FAILED simply re-measures to what was
    // already there.
    const unsubscribe = this.electron.onDocumentStageFinished((event) => {
      const dir = this.projectDir();
      if (dir === '') return;
      if (!samePath(event.projectDir, dir)) return;
      void this.load();
    });
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  // ── Book variants ───────────────────────────────────────────────────────

  /** The manifest projectId — the last segment of the project directory path. */
  private projectId(): string {
    const item = this.item();
    if (item) return studioManifestProjectId(item);
    return this.projectDir().split(/[\\/]/).filter(Boolean).pop() || '';
  }

  private async loadVariants(): Promise<void> {
    const generation = ++this.variantLoadGeneration;
    const pid = this.projectId();
    if (!pid) {
      this.variantList.set([]);
      this.primaryId.set(undefined);
      this.transcriptEligibleVariantIds.set(new Set());
      this.transcriptEligibilityKnown.set(false);
      return;
    }
    this.transcriptEligibilityKnown.set(false);
    try {
      const [res, analysisTargets] = await Promise.all([
        this.electron.variantList(pid),
        this.electron.analysisListAudiobooks(pid),
      ]);
      if (generation !== this.variantLoadGeneration || this.projectId() !== pid) return;
      if (res.success && res.variants) {
        // Each row carries the absPath main resolved against THIS project's dir.
        this.variantList.set(res.variants);
        this.primaryId.set(res.primaryVariantId);
      } else {
        // A FAILED read (e.g. a transient manifest lock on a synced drive) is NOT
        // "this book has no versions" — do not wipe the list, or every version
        // appears to vanish. Keep what's shown and log; the next refresh retries.
        // This only ever keeps rows for the SAME project: the generation guard above
        // discards a superseded load, and load() clears both lists synchronously
        // when the selected book changes, so there is never another book's row left
        // here to be kept.
        console.warn('[studio-versions] variantList failed; keeping current list:', res.error);
      }
      if (analysisTargets.success && analysisTargets.targets) {
        this.transcriptEligibleVariantIds.set(new Set(analysisTargets.targets.map(target => target.variantId)));
        this.transcriptEligibilityKnown.set(true);
      } else {
        // Without a successful authoritative check, do not offer Generate for a
        // possibly embedded transcript and risk replacing it by mistake.
        this.transcriptEligibleVariantIds.set(new Set());
        console.warn('[studio-versions] transcript eligibility failed:', analysisTargets.error);
      }
    } catch (err) {
      console.warn('[studio-versions] variantList threw; keeping current list:', err);
    }
  }

  /** Who narrated an audiobook: its own narrator metadata (user-set, or from an
   *  imported file's tag) if present, else the TTS voice that rendered it. */
  narratorFor(v: ProjectVariant): string {
    const own = (v.metadata?.narrator || '').trim();
    return own || (this.ttsVoice() || '').trim();
  }

  variantIcon(v: ProjectVariant): string { return v.kind === 'audiobook' ? '\u{1F3A7}' : '\u{1F4D6}'; }
  isPrimary(v: ProjectVariant): boolean { return v.id === this.primaryId(); }

  /** Display name: the metadata title with the version description appended in
   *  parentheses, e.g. "One People, One Reich… (German EPUB)". */
  variantTitle(v: ProjectVariant): string {
    const title = (v.metadata?.title || '').trim();
    const desc = (v.descriptor || '').trim();
    if (title && desc) return `${title} (${desc})`;
    if (title) return title;
    if (desc) return desc;
    return 'Untitled version';
  }

  /** The actual on-disk filename of this variant (includes the extension). */
  variantFilename(v: ProjectVariant): string {
    return (v.path || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  /**
   * The file this row addresses, or null after telling the user why there isn't one.
   *
   * There is deliberately NO path arithmetic here. `absPath` was computed in the main
   * process, in the same call that produced this row, from the project directory that
   * row was actually read from — so it cannot be crossed with a different book's
   * directory, which is exactly what the old renderer-side join did whenever the rows
   * had not yet caught up with a new selection.
   *
   * Neither branch below substitutes anything. A row with no `absPath` is a broken
   * contract with `variant:list` (say so — do not reconstruct a path that has never
   * been verified), and a row whose file is gone cannot be opened, exported or played
   * by anyone (say WHICH file, here, rather than letting the editor or the player
   * report an ENOENT on a path the user cannot place).
   */
  private async variantFile(v: ResolvedProjectVariant, action: string): Promise<string | null> {
    if (!v.absPath) {
      await this.electron.showMessageDialog({
        title: `Could not ${action}`,
        message: `BookForge has no resolved file path for the “${this.variantTitle(v)}” version, `
          + 'so there is nothing to act on. This is a bug in how this book\'s versions were '
          + 'loaded — reopen the book, and report it if it happens again.',
        type: 'error',
      });
      return null;
    }
    if (!v.exists) {
      await this.electron.showMessageDialog({
        title: `Could not ${action}`,
        message: `The file for the “${this.variantTitle(v)}” version is not on disk:\n\n${v.absPath}\n\n`
          + 'It may have been moved, deleted, or not yet synced to this machine.',
        type: 'error',
      });
      return null;
    }
    return v.absPath;
  }

  /** Open this version's own file in the editor (standalone, not the pipeline source). */
  async openVariant(v: ResolvedProjectVariant): Promise<void> {
    const abs = await this.variantFile(v, 'open this version');
    if (abs) this.open.emit(abs);
  }

  /** Save a copy of this version's file somewhere else. */
  async exportVariant(v: ResolvedProjectVariant): Promise<void> {
    const abs = await this.variantFile(v, 'export this version');
    if (abs) this.exportDoc.emit(abs);
  }

  /** Play this audiobook version in the player window. */
  async listenVariant(v: ResolvedProjectVariant): Promise<void> {
    const abs = await this.variantFile(v, 'play this audiobook');
    if (abs) this.listen.emit(abs);
  }

  /** Save a copy of this audiobook's M4B somewhere else. */
  async exportAudioVariant(v: ResolvedProjectVariant): Promise<void> {
    const abs = await this.variantFile(v, 'export this audiobook');
    if (abs) this.exportAudio.emit(abs);
  }

  /** Clicking a pipeline document row opens it in the editor (its "edit feature").
   *  Variants open their inline details panel via the row's own toggleEditor. */
  onDocRowClick(v: VersionRow): void {
    if (v.editable) this.openDoc(v);
  }

  /** The editor renders mupdf-backed documents — EPUB and PDF. Audio (m4b) and
   *  other formats have no editor view, so no Open button for them. */
  canOpenInEditor(v: ProjectVariant): boolean {
    if (v.kind !== 'ebook') return false;
    const ext = ((v.format || '') || this.variantFilename(v).split('.').pop() || '').toLowerCase();
    return ext === 'epub' || ext === 'pdf';
  }

  variantSubtitle(v: ProjectVariant): string {
    // Descriptor now lives in the title (in parentheses), so it's dropped here.
    const parts: string[] = [];
    if (v.format) parts.push(v.format.toUpperCase());
    if (v.metadata?.author) parts.push(v.metadata.author);
    if (v.metadata?.language) parts.push(v.metadata.language);
    return parts.join(' · ');
  }

  otherVariants(v: ProjectVariant): ProjectVariant[] {
    return this.variantList().filter(o => o.id !== v.id);
  }

  editorMeta(v: ProjectVariant): EpubMetadata | null {
    return this.editorMetaCache()[v.id] ?? null;
  }

  async toggleEditor(v: ProjectVariant): Promise<void> {
    if (this.openId() === v.id) { this.openId.set(null); return; }
    // Seed the descriptor draft, drop any stale pending cover, and load the current
    // cover BEFORE building the (stable) editor metadata so it's set exactly once.
    this.descriptorDraft.update(d => ({ ...d, [v.id]: v.descriptor || '' }));
    this.pendingCover.update(p => { const { [v.id]: _drop, ...rest } = p; return rest; });
    // Load the cover via ensureCover: it returns the stored cover when present, and
    // otherwise extracts the real one from the variant's own file (m4b art / epub
    // cover) and persists it. So ebook/audiobook variants that were never given a
    // coverPath (imports, pipeline outputs) now show their actual cover here.
    let coverData: string | undefined;
    try {
      const ens = await this.electron.variantEnsureCover(this.projectId(), v.id);
      if (ens.success) {
        if (ens.data) coverData = ens.data;
        // Cache the now-persisted path on the in-memory variant so re-opening is cheap.
        if (ens.coverPath && !v.metadata?.coverPath) v.metadata = { ...(v.metadata || {}), coverPath: ens.coverPath };
      } else {
        console.error('[versions] ensureCover failed:', ens.error);
      }
    } catch (e) { console.error('[versions] ensureCover threw:', e); }
    const m = v.metadata || {};
    this.editorMetaCache.update(c => ({
      ...c,
      [v.id]: {
        title: m.title || '',
        author: m.author || '',
        year: m.year,
        language: m.language || this.item()?.language || 'en',
        coverData,
        contributors: undefined,
      },
    }));
    this.openId.set(v.id);
  }

  /** Descriptor to show in the input: the unsaved draft if one exists (honouring a
   *  deliberately-cleared empty string), else the variant's saved descriptor. */
  descriptorValue(v: ProjectVariant): string {
    const d = this.descriptorDraft();
    return Object.prototype.hasOwnProperty.call(d, v.id) ? d[v.id] : (v.descriptor || '');
  }

  onDescriptor(v: ProjectVariant, value: string): void {
    this.descriptorDraft.update(d => ({ ...d, [v.id]: value }));
  }

  onCover(v: ProjectVariant, dataUrl: string): void {
    // The metadata-editor already updates its own preview; we only record the new
    // image so saveVariant persists it. (Empty string = the user removed the cover.)
    this.pendingCover.update(p => ({ ...p, [v.id]: dataUrl }));
  }

  async saveVariant(v: ProjectVariant, emitted: EpubMetadata): Promise<void> {
    const pid = this.projectId();
    if (!pid) return;
    this.savingId.set(v.id);
    try {
      const meta: Record<string, unknown> = {
        title: emitted.title,
        author: emitted.author,
        year: emitted.year,
        language: emitted.language,
        descriptor: this.descriptorDraft()[v.id] ?? (v.descriptor || ''),
      };
      const cover = this.pendingCover()[v.id];
      const res = await this.electron.variantSaveMetadata(pid, v.id, meta, cover || undefined);
      if (!res.success) {
        await this.electron.showMessageDialog({ title: 'Save failed', message: res.error || 'Could not save this version.', type: 'error' });
        return;
      }
      this.pendingCover.update(p => { const { [v.id]: _d, ...rest } = p; return rest; });
      await this.loadVariants();
      this.changed.emit();
    } finally {
      this.savingId.set(null);
    }
  }

  async setPrimary(v: ProjectVariant): Promise<void> {
    const pid = this.projectId();
    if (!pid) return;
    const res = await this.electron.variantSetPrimary(pid, v.id);
    if (res.success) { await this.loadVariants(); this.changed.emit(); }
  }

  isProfessional(v: ProjectVariant): boolean {
    return !!v.professionallyRead;
  }

  async setProfessional(v: ProjectVariant, value: boolean): Promise<void> {
    const pid = this.projectId();
    if (!pid) return;
    const res = await this.electron.variantSetProfessional(pid, v.id, value);
    if (res.success) { await this.loadVariants(); this.changed.emit(); }
  }

  async pullFrom(v: ProjectVariant, fromId: string): Promise<void> {
    if (!fromId) return;
    const pid = this.projectId();
    if (!pid) return;
    const res = await this.electron.variantPullMetadata(pid, fromId, v.id, ['title', 'author', 'year', 'language', 'narrator', 'series', 'seriesPosition', 'description', 'coverPath']);
    if (!res.success) return;
    await this.loadVariants();
    this.changed.emit();
    // Reopen so the editor + cover reflect the pulled values.
    const fresh = this.variantList().find(x => x.id === v.id);
    if (fresh) { this.openId.set(null); await this.toggleEditor(fresh); }
  }

  async remove(v: ProjectVariant): Promise<void> {
    const label = this.variantTitle(v);
    const warnFile = v.kind === 'audiobook'
      ? ' Its audiobook file will be deleted.'
      : ' Its file will be deleted.';
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete version',
      message: `Delete the "${label}" version of this book?` + warnFile + ' This cannot be undone.',
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const pid = this.projectId();
    if (!pid) return;
    const res = await this.electron.variantDelete(pid, v.id);
    if (res.success) {
      if (this.openId() === v.id) this.openId.set(null);
      await this.loadVariants();
      this.changed.emit();
    } else {
      await this.electron.showMessageDialog({
        title: 'Delete failed',
        message: res.error || 'Could not delete this version. The file was left in place — try again.',
        type: 'error',
      });
    }
  }

  // ── Adding versions ───────────────────────────────────────────────────────

  async addViaDialog(): Promise<void> {
    const res = await this.electron.openVersionDialog();
    if (!res.success || !res.filePaths || res.filePaths.length === 0) return;
    await this.addFiles(res.filePaths);
  }

  private async addFiles(paths: string[]): Promise<void> {
    const pid = this.projectId();
    if (!pid || paths.length === 0) return;
    // Mark THIS project busy (not the component) so the user can switch to
    // another book and start a second import while this one runs. The transcode
    // progress bar is fed by VariantImportService's app-lifetime listener, keyed
    // by this same pid, and survives this component being re-created.
    this.imports.begin(pid);
    const errors: string[] = [];
    let lastAddedId: string | undefined;
    try {
      for (const p of paths) {
        const ext = (p.split('.').pop() || '').toLowerCase();
        let addPath = p;
        if (!AUDIO_EXTS.has(ext)) {
          // Ebook: add native formats directly; convert everything else via Calibre.
          const { convertible, native } = await this.electron.isEbookConvertible(p);
          if (!native) {
            if (!convertible) { errors.push(`${p.split(/[\\/]/).pop()}: unsupported format`); continue; }
            const conv = await this.electron.convertEbook(p);
            if (!conv.success || !conv.outputPath) { errors.push(`${p.split(/[\\/]/).pop()}: conversion failed`); continue; }
            addPath = conv.outputPath;
          }
        }
        const res = await this.electron.variantAdd(pid, addPath);
        this.imports.clearProgress(pid); // this file's conversion is over either way
        if (!res.success) errors.push(`${p.split(/[\\/]/).pop()}: ${res.error || 'failed'}`);
        else if (res.variantId) lastAddedId = res.variantId;
      }
    } finally {
      this.imports.end(pid);
    }
    // The user may have switched books while this import ran. Only touch the
    // visible editor's state when we're still on the project we added to;
    // switching away already reloads that project's variants via load(). Still
    // notify Studio so the shelf/list picks up the new version.
    this.changed.emit();
    if (errors.length) {
      await this.electron.showMessageDialog({
        title: 'Some versions were not added',
        message: errors.join('\n'), type: 'warning',
      });
    }
    if (this.projectId() !== pid) return;
    await this.loadVariants();
    // Open the newly-added version's metadata editor so the user can describe it.
    if (lastAddedId) {
      const fresh = this.variantList().find(x => x.id === lastAddedId);
      if (fresh) await this.toggleEditor(fresh);
    }
  }

  onVDragEnter(e: DragEvent): void {
    e.preventDefault(); e.stopPropagation();
    this.vDragCounter++;
    if (e.dataTransfer?.types.includes('Files')) this.vDragOver.set(true);
  }
  onVDragOver(e: DragEvent): void { e.preventDefault(); e.stopPropagation(); }
  onVDragLeave(e: DragEvent): void {
    e.preventDefault(); e.stopPropagation();
    this.vDragCounter--;
    if (this.vDragCounter <= 0) { this.vDragCounter = 0; this.vDragOver.set(false); }
  }
  onVDrop(e: DragEvent): void {
    e.preventDefault(); e.stopPropagation();
    this.vDragOver.set(false); this.vDragCounter = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const fp = (files[i] as unknown as { path?: string }).path;
      if (fp) paths.push(fp);
    }
    if (paths.length) void this.addFiles(paths);
  }

  // ── Pipeline document versions ──────────────────────────────────────────

  isEpub(v: VersionRow): boolean { return (v.extension || '').toLowerCase() === 'epub'; }

  /** The skipped-sentences report belongs to the cleanup output it was produced with. */
  hasSkippedReport(v: VersionRow): boolean {
    return !!this.item()?.skippedChunksPath && (v.type === 'cleaned' || v.type === 'simplified');
  }

  /**
   * Which rows can be deleted, and by what.
   *
   * Three different acts, each routed to the code that already owns it — see
   * `removeDoc`. What is NOT here is a fourth: 'original' (the pre-archive
   * `source/original.*` of an old project) and 'analysis' (deleted by its own
   * button, which also removes the checkpoint) keep their existing protection.
   *
   * 'archive' is deletable, and it was until yesterday: the archive original is
   * a manifest VARIANT, and every variant row in "Book versions" has always had
   * a Delete that routes through `variant:delete`. Moving the original into the
   * document family took its buttons away without deciding it should be
   * undeletable. Restoring it is not a new capability.
   */
  deletable(v: VersionRow): boolean {
    if (v.type === 'archive') {
      // No variant id means main could not say which record this file is, and
      // `variant:delete` is the only safe remover (record first, file after).
      // Deleting by path instead is the guess that handler exists to avoid.
      return !!v.variantId;
    }
    if (v.type === 'working') return !!v.primaryPath;
    return !['original', 'analysis'].includes(v.type);
  }

  deleteTitle(v: VersionRow): string {
    switch (v.type) {
      case 'archive':
        return 'Delete the original this book was imported from — and everything cast from it';
      case 'working':
        return 'Delete your working copy: the cast text and your block curation. The original is untouched.';
      case 'exported':
        return 'Delete the book EPUB, and the record of every pass applied to it';
      default:
        return 'Delete this version';
    }
  }

  async load(): Promise<void> {
    const dir = this.projectDir();
    const generation = ++this.loadGeneration;
    // True once a NEWER load() has started, or the selected book has moved on.
    // Everything this load is about to publish belongs to `dir`, so publishing it
    // after that point would put one book's rows under another book's identity.
    const superseded = () => generation !== this.loadGeneration || this.projectDir() !== dir;

    // Leave any in-progress compare when the project changes or files refresh
    if (this.comparing()) this.closeCompare();
    this.openId.set(null);

    // A DIFFERENT book than the rows on screen: drop them NOW, synchronously,
    // before the first await. A row is only meaningful together with the project it
    // was read from — its file, its metadata editor, its analysis target and its
    // delete all address that project — so rows from the previously selected book
    // are not "slightly stale" here, they are wrong, and every action offered on
    // them acts on a file that does not exist. (This is what produced
    // "<project B>/archive/<book A>.pdf: ENOENT" from the Open button: the rows were
    // still A's while the selection was already B.) Clearing before the await also
    // means the keep-the-list-on-failure policy below can only ever preserve rows
    // that belong to THIS book.
    if (this.loadedForProjectDir() !== dir) {
      this.versions.set([]);
      this.variantList.set([]);
      this.primaryId.set(undefined);
      this.transcriptEligibleVariantIds.set(new Set());
      this.transcriptEligibilityKnown.set(false);
      this.cache.set(null);
      this.ttsVoice.set(null);
      // The sentence picker holds a row from the book that is going away, and
      // startGenerateSentences pairs that row with the LIVE projectId() — leaving it
      // open would let one book's file be queued under another book's project.
      this.pickerVariant.set(null);
      // Per-variant editing drafts. Synthesized archive variants get ids derived from
      // their relative path (`arch:archive/original.epub`), which two different books
      // can share, so a draft left behind here can reappear on another book's row.
      this.descriptorDraft.set({});
      this.pendingCover.set({});
      this.editorMetaCache.set({});
      this.passDiffs.set([]);
      this.passDiffError.set(null);
      // Another book's read failure says nothing about this one's.
      this.versionsError.set(null);
      // The reset plan names another book's files; a Start over enabled by it
      // would offer to delete them under this book's name.
      this.resetPlan.set(null);
      this.resetPlanError.set(null);
      this.loadedForProjectDir.set(dir);
    }

    if (!dir) { this.loading.set(false); return; }
    this.loading.set(true);
    try {
      const res = await this.electron.editorGetVersions(dir);
      if (superseded()) return;
      if (res.success && res.versions) {
        this.versions.set(res.versions as VersionRow[]);
        this.versionsError.set(null);
      } else {
        // A FAILED read (e.g. a transient manifest lock on a synced drive) is NOT
        // "this book has no documents" — do not wipe the list, or every version
        // appears to vanish. Keep what's shown and log; the next refresh retries.
        // Safe because the clear above already guaranteed anything still shown was
        // loaded for THIS book. (Mirrors loadVariants below.)
        //
        // Kept, but no longer kept QUIETLY: a failure that persists leaves a
        // stale or empty list with nothing on screen to explain it.
        console.warn('[studio-versions] editorGetVersions failed; keeping current list:', res.error);
        this.versionsError.set(
          `This book's versions could not be read, so what's below may be out of date: `
          + `${res.error || 'no reason given'}`);
      }
    } catch (err) {
      if (superseded()) return;
      console.warn('[studio-versions] editorGetVersions threw; keeping current list:', err);
      this.versionsError.set(
        `This book's versions could not be read, so what's below may be out of date: `
        + `${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Only the load that still owns the UI may clear the spinner — otherwise this
      // one's exit would say "done" about a newer book that is still loading.
      if (!superseded()) this.loading.set(false);
    }
    if (superseded()) return;
    await this.loadCache(dir, superseded);
    if (superseded()) return;
    await this.loadPassDiffs(dir, superseded);
    if (superseded()) return;
    await this.loadResetPlan(dir, superseded);
    if (superseded()) return;
    await this.loadVariants();
  }

  /**
   * Which passes over this book left a diff, from the manifest's own provenance.
   *
   * The list is the index — a pass whose job died halfway never recorded itself,
   * so it is not offered next to one that finished. A failure to READ the list is
   * reported: "no passes recorded" and "the record could not be read" are
   * different facts and the user is told which one they have.
   */
  private async loadPassDiffs(dir: string, superseded: () => boolean): Promise<void> {
    const res = await this.electron.listPassDiffs(dir);
    if (superseded()) return;
    if (!res.success || !res.diffs) {
      this.passDiffs.set([]);
      this.passDiffError.set(
        `The record of what's been done to this book could not be read: ${res.error || 'no reason given'}`
      );
      return;
    }
    this.passDiffError.set(null);
    this.passDiffs.set(res.diffs);
  }

  // ── Start over ─────────────────────────────────────────────────────────────

  /** What a reset would remove for this project, from main — never guessed here. */
  readonly resetPlan = signal<BookResetSummary | null>(null);
  readonly resetPlanError = signal<string | null>(null);
  readonly resetting = signal(false);

  /**
   * The run directory is machine-local and the stage directories are on disk, so
   * only main can say whether this project has processing state. The preview is
   * the SAME call the reset makes, so the button's enabled state and the dialog's
   * list cannot disagree with what the reset then does.
   */
  private async loadResetPlan(dir: string, superseded: () => boolean): Promise<void> {
    const res = await this.electron.resetBookProcessing(dir, true);
    if (superseded()) return;
    if (!res.success || !res.summary) {
      this.resetPlan.set(null);
      this.resetPlanError.set(res.error || 'no reason given');
      return;
    }
    this.resetPlanError.set(null);
    this.resetPlan.set(res.summary);
  }

  readonly canStartOver = computed(() => {
    const plan = this.resetPlan();
    return !!plan && !plan.empty;
  });

  readonly startOverTitle = computed(() => {
    if (this.resetPlanError()) {
      return `Whether this book has anything to reset could not be read: ${this.resetPlanError()}`;
    }
    const plan = this.resetPlan();
    if (!plan) return 'Checking what this book has been through…';
    if (plan.empty) {
      return 'There is nothing to reset — this book has no scan, no passes and no book EPUB yet.';
    }
    return 'Delete every trace of processing (scan, OCR, footnote and simplify passes, the book '
      + 'EPUB and your block deletions) and start this book over from its source document.';
  });

  /**
   * The queue jobs that make a reset unsafe: anything queued or running against
   * THIS project.
   *
   * The queue lives in the renderer, so this is the honest place to ask — the
   * signal IS the queue, not a copy of it. (Main gates too, on the foundry run
   * it owns, because a run outlives an ng-serve reload of this window.) A pass
   * job's project is in its config; the older job families carry it as `bfpPath`
   * or `projectDir`, the persisted key names.
   */
  private blockingQueueJobs(dir: string): Array<{ type: string; label: string }> {
    const same = (p?: string) => !!p && p.replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, '');
    return this.queue.jobs()
      .filter(j => j.status === 'pending' || j.status === 'processing')
      .filter(j => same(j.bfpPath)
        || same(j.projectDir)
        || same((j.config as { projectDir?: string } | undefined)?.projectDir))
      .map(j => ({ type: j.type, label: j.epubFilename || j.epubPath || j.id }));
  }

  /**
   * Delete everything this book's processing produced and leave the source.
   *
   * The confirmation names the actual files main resolved — the run directory on
   * this machine, each pass stage directory, the book EPUB by its recorded name
   * — because "clears processing state" is not something a user can check
   * against what they care about keeping.
   */
  async startOver(): Promise<void> {
    const dir = this.projectDir();
    if (!dir || !this.canStartOver() || this.resetting()) return;

    const blocking = this.blockingQueueJobs(dir);
    if (blocking.length > 0) {
      const first = blocking[0];
      await this.electron.showMessageDialog({
        title: 'Not while this book is in the queue',
        message: `A ${first.type} job for this book is queued or running (${first.label})`
          + `${blocking.length > 1 ? ` — and ${blocking.length - 1} more` : ''}. `
          + 'Let it finish or remove it from the Queue, then start over.',
        type: 'warning',
      });
      return;
    }

    const plan = this.resetPlan()!;
    const present = plan.items.filter(i => i.present);
    const absent = plan.items.filter(i => !i.present);
    const detail = [
      'This deletes, for this book:',
      ...present.map(i => `  • ${i.label}${i.path ? `\n      ${i.path}` : ''}`),
      ...(absent.length > 0
        ? ['', 'Not present, so nothing to remove:', ...absent.map(i => `  • ${i.label}`)]
        : []),
      '',
      'Your block deletions in the PDF editor go with it — a re-scan mints new line ids, so keeping them would leave records that refuse every future export.',
      '',
      'KEPT: the source PDF/EPUB, the cover, all metadata, finished audiobooks, the TTS sentence cache, and the language-learning files.',
      '',
      'The next processing run rebuilds everything from the pages.',
    ].join('\n');

    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Start this book over',
      message: 'Delete everything processing has produced for this book?',
      detail,
      confirmLabel: 'Start over', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    this.resetting.set(true);
    try {
      const res = await this.electron.resetBookProcessing(dir, false);
      if (!res.success) {
        await this.electron.showMessageDialog({
          title: 'Could not start over',
          message: res.error || 'The reset failed and gave no reason.',
          type: 'error',
        });
        return;
      }
    } finally {
      this.resetting.set(false);
      await this.load();
      this.changed.emit();
    }
  }

  /** Read the durable TTS sentence cache for this project (if any) so the
   *  Versions list can show how much is rendered and offer Continue/Assemble/Delete.
   *  `superseded` is load()'s ownership test: the sentence count and the narrator
   *  belong to `dir`, so they must not be written once another book owns the UI. */
  private async loadCache(dir: string, superseded: () => boolean): Promise<void> {
    this.cache.set(null);
    this.ttsVoice.set(null);
    const electron = (window as any).electron;
    if (!electron?.reassembly?.getBfpSession) return;
    try {
      const res = await electron.reassembly.getBfpSession(dir);
      if (superseded()) return;
      const d = res?.success ? res.data : null;
      // The rendering voice (e2a's fineTuned), independent of how much is cached —
      // feeds the audiobook "Narrator" box for TTS output with no explicit narrator.
      this.ttsVoice.set(d?.provenance?.voice ?? null);
      if (d && typeof d.totalSentences === 'number' && d.totalSentences > 0) {
        const completed = d.completedSentences ?? 0;
        this.cache.set({
          language: d.language,
          totalSentences: d.totalSentences,
          completedSentences: completed,
          percentComplete: d.percentComplete ?? Math.round((completed / d.totalSentences) * 100),
          complete: d.complete ?? completed >= d.totalSentences,
        });
      }
    } catch { /* no cache / IPC unavailable — leave it hidden */ }
  }

  /** A version is comparable only if a pre-computed diff record was produced for it. */
  hasDiffRecord(v: VersionRow): boolean { return !!v.diffRecordPath; }

  /** The source EPUB a derived version was produced from (prefer 'exported', else 'original'). */
  private sourceEpubPath(): string | undefined {
    const docs = this.documents();
    return docs.find(v => v.type === 'exported')?.path
      ?? docs.find(v => v.type === 'original')?.path;
  }

  /**
   * One-click review of the changes made to produce a derived version.
   * Compares the version against the original its diff was recorded against
   * (falling back to the project's source EPUB), in the correct order so the
   * pre-computed diff record is used rather than an empty on-demand compare.
   */
  startCompare(v: VersionRow): void {
    const original = v.diffOriginalPath || this.sourceEpubPath();
    if (!original) return;
    this.comparing.set({ mode: 'paths', a: original, b: v.path, labelA: 'Original', labelB: v.label });
    this.compareActive.emit(true);
  }

  closeCompare(): void {
    this.comparing.set(null);
    this.passReport.set(null);
    this.compareActive.emit(false);
  }

  /**
   * Delete the working copy: the PDF, its binding record and the machine-local
   * scan scratch — the three files `document:discard` removes as ONE act.
   *
   * That handler, not a `deleteFile` on the PDF. The binding is what says a
   * working document exists and which original it was cast from; deleting the
   * file alone would leave a record vouching for a document that is gone, which
   * is the state `listWorkingDocuments` has to skip rows for and the picker
   * would then try to re-open. Whatever cannot be removed together is not
   * removed at all: the handler fails as a whole and this says so by name.
   *
   * The archive original is untouched — it is what the next Cast reads — and the
   * book EPUB, if one was built, survives: it is a separate artifact, and
   * nothing about deleting the PDF says the user is finished with their book.
   */
  private async removeWorkingCopy(v: VersionRow): Promise<void> {
    const dir = this.projectDir();
    const primary = v.primaryPath;
    if (!dir || !primary) {
      // Both are set by main on every working row it emits. Missing means IPC
      // shape drift, not a state — refuse rather than guess a path to delete.
      await this.electron.showMessageDialog({
        title: 'Could not delete the working copy',
        message: 'BookForge cannot tell which original this working copy was cast from, so it '
          + 'cannot name the document to remove. Reopen the book, and report this if it happens again.',
        type: 'error',
      });
      return;
    }

    const boundaries = v.stageBoundaries ?? [];
    const detail = [
      `This deletes ${v.path.split(/[\\/]/).pop()} and the record that binds it to your original:`,
      '  • the cast text layer — the words you can select and search',
      '  • your block curation: labels, deletions, merges and chapter titles',
      ...(boundaries.length > 0
        ? ['  • the stages recorded on it: '
          + boundaries.map(b => this.BOUNDARY_LABELS[b.stage] ?? b.stage).join(', ')]
        : []),
      '',
      'KEPT: the archive original (untouched — Cast reads it again to start over), and the book '
      + 'EPUB if one has been built.',
    ].join('\n');

    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete the working copy',
      message: 'Delete your working copy of this book?',
      detail,
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    const res = await this.electron.discardWorkingDocument(dir, primary);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Delete failed',
        message: res.error || 'The working copy could not be deleted, and gave no reason. '
          + 'Nothing was removed.',
        type: 'error',
      });
      return;
    }
    await this.load();
    this.changed.emit();
  }

  /**
   * Delete the archive original — the source everything else was derived from.
   *
   * Routed through `variant:delete`, which is what every row in "Book versions"
   * has always used: it removes the manifest record FIRST and only unlinks the
   * file once that write is confirmed, so a failure can never leave a file gone
   * while the project still lists it. The archive original is a variant like any
   * other version of the book (`arch:archive/<name>.pdf`), and that handler
   * already knows an `arch:` variant's file IS its archive file.
   *
   * The working copy goes FIRST, and must: it is a copy of these bytes, stamped
   * with their hash, and its binding names this file. Leaving it would leave a
   * record vouching for an original that is gone — and every stage re-proves
   * that hash, so it could never be worked on again either. If the working copy
   * cannot be removed, the original is not touched: that is the recoverable
   * direction, and the user is told which half stopped it.
   *
   * The book EPUB is NOT deleted. It is a finished artifact the user may still
   * want, and nothing about it depends on the original being present. The
   * confirmation says so rather than leaving them to find out.
   */
  private async removeArchiveOriginal(v: VersionRow): Promise<void> {
    const pid = this.projectId();
    const dir = this.projectDir();
    const variantId = v.variantId;
    if (!pid || !variantId) {
      await this.electron.showMessageDialog({
        title: 'Could not delete the original',
        message: 'BookForge has no manifest record for this file, so there is no version to '
          + 'delete — only bytes it cannot vouch for. Reopen the book, and report this if it '
          + 'happens again.',
        type: 'error',
      });
      return;
    }

    const working = this.documents().find(d => d.type === 'working') ?? null;
    const book = this.documents().find(d => d.type === 'exported') ?? null;
    const detail = [
      `This deletes ${v.path}`,
      '',
      'It is the book exactly as you imported it, and everything else here was made from it. '
      + 'BookForge keeps no other copy.',
      '',
      ...(working
        ? [
          'GOES WITH IT — your working copy was cast from this file and is bound to it by hash:',
          `  • ${working.path.split(/[\\/]/).pop()}`,
          '  • the cast text layer, and your block labels, deletions, merges and chapter titles',
          '',
        ]
        : []),
      ...(book
        ? [
          `KEPT: the book you built from it — ${book.path.split(/[\\/]/).pop()} — with everything `
          + 'applied to it. It cannot be rebuilt once the original is gone.',
          '',
        ]
        : []),
      'KEPT: your finished audiobooks, the rendered sentence cache, the cover and all metadata.',
      '',
      'This cannot be undone.',
    ].join('\n');

    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete the original',
      message: `Delete "${v.label}" — the original this book was imported from?`,
      detail,
      confirmLabel: 'Delete the original', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    if (working && dir && working.primaryPath) {
      const discarded = await this.electron.discardWorkingDocument(dir, working.primaryPath);
      if (!discarded.success) {
        await this.electron.showMessageDialog({
          title: 'Delete stopped — the original is still here',
          message: 'The working copy cast from this original could not be removed: '
            + `${discarded.error || 'no reason given'}.\n\nNothing was deleted. The original is `
            + 'untouched, because leaving a working copy bound to an original that is gone would '
            + 'leave a document nothing can verify or reopen.',
          type: 'error',
        });
        return;
      }
    }

    const res = await this.electron.variantDelete(pid, variantId);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Delete failed',
        message: res.error || 'Could not delete the original. The file was left in place — try again.',
        type: 'error',
      });
    }
    await this.load();
    await this.loadVariants();
    this.changed.emit();
  }

  /**
   * Delete the book EPUB — and, with it, the diffs of every pass applied to it.
   *
   * Owen, third session: "if that file is removed, so is the diff and its
   * viewing button." So this is `document:delete-book`, one act in main, rather
   * than a `deleteFile` with tidying bolted on: the manifest record, the
   * `appliedPasses` provenance, the `stages/NN-<kind>/` directories those passes
   * wrote, the binding's own note of the book, and last of all the file.
   */
  private async removeBookEpub(v: VersionRow): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;
    const withDiffs = this.passDiffs();
    const passes = this.item()?.appliedPasses ?? [];
    const detail = [
      `This deletes ${v.path.split(/[\\/]/).pop()}.`,
      '',
      ...(passes.length > 0
        ? [
          `GOES WITH IT: the record of the ${passes.length} pass${passes.length === 1 ? '' : 'es'} `
          + 'applied to this book, and their stars'
          + (withDiffs.length > 0
            ? `, including the ${withDiffs.length} you can still review — once the book is gone `
            + 'there is no file for those changes to be changes TO.'
            : '.'),
          '',
        ]
        : []),
      'KEPT: the archive original and your working copy. Build the book again from them whenever '
      + 'you like — the passes are re-runnable.',
    ].join('\n');

    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete the book',
      message: `Delete "${v.label}"?`,
      detail,
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    const res = await this.electron.deleteBookEpub(dir);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Delete failed',
        message: res.error || 'Could not delete the book. Try again.',
        type: 'error',
      });
      return;
    }
    // The whole-file diff sidecar (`<name>.diff.json`) an older pipeline wrote
    // beside this book, if the versions scan found one. It is not in the
    // manifest's provenance, so main cannot see it — but it is a diff OF THIS
    // FILE, and the file has just gone.
    if (v.diffRecordPath) {
      const delDiff = await this.electron.deleteFile(v.diffRecordPath);
      if (!delDiff.success) {
        console.warn('[studio-versions] the book was deleted but its diff sidecar survived:', delDiff.error);
      }
    }
    await this.load();
    this.changed.emit();
  }

  async removeDoc(v: VersionRow): Promise<void> {
    // The family's three rows are three different acts, each owned by the code
    // that already knows how to undo that artifact. Only the rows below them —
    // the legacy stage outputs — take the generic file delete.
    if (v.type === 'working') { await this.removeWorkingCopy(v); return; }
    if (v.type === 'archive') { await this.removeArchiveOriginal(v); return; }
    if (v.type === 'exported') { await this.removeBookEpub(v); return; }

    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete version',
      message: `Delete "${v.label}"? The original archived copy is not affected.`,
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;

    // Cleaned / Simplified EPUBs live in the SHARED stages/01-cleanup/ directory
    // alongside a set of sidecars: the diff cache the Review UI reads, the resume
    // checkpoint (cleanup-progress.json — if it survives a delete the NEXT run
    // resumes from stale chapters), the edit-list audit, the pre-pass report and
    // the skipped-chunk record. Translated EPUBs live in stages/02-translate/ with
    // their own diff cache, sentence-pair export and resume artifact (the mono
    // translation-progress.json + chapter-cache/, or an LL sentences/<lang>.json).
    // Deleting only the .epub would strand all of those and leave the project in a
    // lying state — most dangerously letting a re-run RESUME from the deleted
    // chapters. Route through the stage-aware main handlers, which remove this
    // output's whole set and leave sibling outputs (the other cleanup/simplify
    // pass, or another language) intact. Gate on the file ACTUALLY living under the
    // stage dir so legacy projects (cleaned.epub in an audiobook folder) still take
    // the direct-delete path below rather than no-op'ing against a stage dir that
    // isn't there.
    const inCleanupStage = /[\\/]stages[\\/]01-cleanup[\\/]/.test(v.path);
    const inTranslateStage = /[\\/]stages[\\/]02-translate[\\/]/.test(v.path);
    const projectDir = this.projectDir();
    const pipeline = (window as any).electron?.pipeline;
    const epubName = v.path.split(/[\\/]/).pop();
    let res: { success: boolean; error?: string };

    if (inCleanupStage && projectDir && (v.type === 'cleaned' || v.type === 'simplified')) {
      const del = v.type === 'cleaned' ? pipeline?.deleteCleanup : pipeline?.deleteSimplify;
      if (!del) {
        // No silent fallback to a file-only delete — that would strand the very
        // sidecars this branch exists to remove. Surface the wiring failure.
        res = { success: false, error: 'Stage delete handler unavailable' };
      } else {
        res = await del(projectDir);
      }
    } else if (inTranslateStage && projectDir && v.type === 'translated' && epubName) {
      // Delete just THIS language's files (epub, diff, sentence-pair export and
      // resume cache) so a re-run does not resume from the deleted chapters and
      // sibling languages stay intact. No silent fallback for the same reason.
      const del = pipeline?.deleteTranslation;
      if (!del) {
        res = { success: false, error: 'Stage delete handler unavailable' };
      } else {
        res = await del(projectDir, epubName);
      }
    } else {
      // A legacy cleaned/simplified/translated file that owns no shared stage
      // directory. (The book EPUB never reaches here — `removeBookEpub` above
      // owns it, because its provenance and its diffs have to go with it.)
      // Delete the file plus the pre-computed diff sidecar the versions scan
      // found next to it.
      res = await this.electron.deleteFile(v.path);
      if (res.success && v.diffRecordPath) {
        const delDiff = await this.electron.deleteFile(v.diffRecordPath);
        if (!delDiff.success) {
          console.warn('[studio-versions] version deleted but its diff sidecar survived:', delDiff.error);
        }
      }
    }

    if (res.success) {
      await this.load();
      this.changed.emit();
    } else {
      await this.electron.showMessageDialog({
        title: 'Delete failed',
        message: res.error || 'Could not delete this version. Try again.',
        type: 'error',
      });
    }
  }

  /**
   * Clear ALL persisted editor state for this project's source (deletions,
   * corrections, splits/merges, chapter markers, crops, category learning,
   * undo/redo) via the shared pipeline:reset-editor-state handler — the same
   * code path as Studio's context-menu reset. The archive/original file is
   * untouched. Deleting the export is opt-in and routed through the same
   * deleteFile mechanism removeDoc uses.
   *
   * The export is NAMED AFTER THE BOOK, so every string here says the name the
   * record actually carries. Hard-coding "exported.epub" told the user a file
   * existed that has not been written since the rename (Aug 3 2026).
   */
  async resetEdits(): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;

    // The exported working EPUB (if any) goes stale the moment edits are cleared.
    const exported = this.documents().find(d => d.type === 'exported');
    const exportedName = exported ? exported.path.split(/[\\/]/).pop()! : null;

    const detail = [
      'This clears every edit you made in the editor for this source:',
      '  • deleted blocks and deleted pages',
      '  • text corrections and block edits',
      '  • block splits and merges',
      '  • chapter markers',
      '  • crop regions',
      '  • category learning and custom categories',
      '  • undo / redo history',
      '',
      'The archive/original source file itself is NOT touched — re-opening the editor starts fresh, as if the file had just been imported.',
    ].join('\n');

    const { confirmed, checkboxChecked } = await this.electron.showConfirmDialog({
      title: 'Reset edits',
      message: 'Reset all editor edits for this book?',
      detail,
      confirmLabel: 'Reset edits', cancelLabel: 'Cancel', type: 'warning',
      checkboxLabel: exportedName ? `Also delete ${exportedName}` : undefined,
    });
    if (!confirmed) return;

    const res = await this.electron.resetEditorState(dir);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Reset failed',
        message: res.error || 'Could not reset editor state. Try again.',
        type: 'error',
      });
      return;
    }

    if (checkboxChecked && exported && exportedName) {
      // The SAME delete the book's own row performs — the record, the passes
      // applied to it and their diffs go with the file. A plain unlink here
      // would leave `outputs.epub` naming a file that is gone and a "Review
      // changes" star for a book nobody has.
      const del = await this.electron.deleteBookEpub(dir);
      if (!del.success) {
        // Edits were reset, but the stale export survived (e.g. a transient
        // lock on the synced drive) — say so instead of implying it's gone.
        await this.electron.showMessageDialog({
          title: `${exportedName} not deleted`,
          message: `Edits were reset, but ${exportedName} could not be deleted: ${del.error || 'unknown error'}. Delete it manually from the Versions list.`,
          type: 'warning',
        });
      }
    }

    await this.load();
    this.changed.emit();
  }

  /** Delete every cached sentence-audio file for this book (all languages). */
  async deleteCache(): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;
    const c = this.cache();
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete sentence cache',
      message: `Delete all ${c ? c.completedSentences.toLocaleString() + ' ' : ''}cached sentence-audio files for this book? ` +
        `You'll have to re-render to make an audiobook. The finished audiobook (if any) is not affected.`,
      confirmLabel: 'Delete cache', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const electron = (window as any).electron;
    try {
      await electron?.pipeline?.deleteTtsCache?.(dir);
    } finally {
      await this.load();
      this.changed.emit();
    }
  }

  fmtSize(b: number): string { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }
  fmtDate(iso: string): string { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleDateString(); }

  // ── Generate sentences (Whisper) ──────────────────────────────────────────

  // The picker holds the row it was opened on, resolved path included — the queued
  // job needs that path, and it must be the one main resolved for this row.
  readonly pickerVariant = signal<ResolvedProjectVariant | null>(null);
  readonly whisperModels = signal<WhisperModelStatus[]>([]);
  readonly pickerModelId = signal<string | null>(null);
  readonly pickerError = signal<string | null>(null);
  /** Alignment method: 'epub-align' aligns the project ebook; 'whisper' transcribes. */
  readonly pickerMethod = signal<'epub-align' | 'whisper'>('whisper');
  /** When method='epub-align', the ebook variant id to align against. */
  readonly pickerEpubId = signal<string | null>(null);

  /** Ebook variants offered in the epub-align dropdown. */
  readonly pickerEpubOptions = computed<DesktopSelectItems>(() =>
    this.ebookVariants().map(v => ({
      value: v.id,
      label: this.variantTitle(v) + (v.descriptor ? ' — ' + v.descriptor : ''),
      badge: v.metadata?.language || undefined,
    })));

  readonly whisperRuntimeInstalled = computed(() => this.components.isInstalled('whisper'));
  /** The epub-align method needs the whisperx alignment env — no silent runtime fallback. */
  readonly alignEngineInstalled = computed(() => this.components.isInstalled('whisperx-env'));
  /** Live label while the alignment engine install runs, else null. The install
      runs in phases: `download`/`extract` carry a real percentage, but the later
      relink (`postinstall`) and `verify-run` phases reset pct to 0 and run for
      MINUTES with no further updates. Showing "0%" for those made the install
      look stuck/failed, so surface a phase label instead of a misleading number. */
  readonly alignEngineInstalling = computed(() => {
    const c = this.components.components().find(s => s.component.id === 'whisperx-env');
    if (c?.state !== 'installing') return null;
    const p = c.progress;
    if (p && (p.phase === 'download' || p.phase === 'extract')) {
      return `Downloading… ${Math.round(p.pct ?? 0)}%`;
    }
    if (p && p.phase === 'postinstall') return 'Finishing install…';
    if (p && p.phase === 'verify-run') return 'Verifying…';
    return 'Installing…';
  });

  /** Inline install for the ebook-alignment engine (same managed install as the
      Settings → Speech to Text → Ebook Alignment card). */
  async installAlignEngine(ev: Event): Promise<void> {
    ev.preventDefault(); ev.stopPropagation();
    this.pickerError.set(null);
    await this.components.install('whisperx-env');
    if (!this.components.isInstalled('whisperx-env')) {
      this.pickerError.set(this.components.error()
        || 'The ebook-alignment engine could not be installed — see Settings → Speech to Text.');
    } else if (this.pickerVariant()) {
      // The user installed it to use it — select the now-enabled method.
      this.pickerMethod.set('epub-align');
    }
  }

  private hasAuthoritativeTranscript(v: ProjectVariant): boolean {
    return v.kind === 'audiobook'
      && (!!v.vttPath || this.transcriptEligibleVariantIds().has(v.id));
  }

  /** Only audiobook variants without an embedded or linked transcript can generate sentences. */
  canGenerateSentences(v: ProjectVariant): boolean {
    return v.kind === 'audiobook'
      && this.transcriptEligibilityKnown()
      && !this.hasAuthoritativeTranscript(v);
  }

  /** An audiobook with an embedded or linked transcript can re-transcribe it. */
  canRegenerateSentences(v: ProjectVariant): boolean {
    return this.hasAuthoritativeTranscript(v);
  }

  /** The picker is in "regenerate" mode when the chosen variant already has a VTT. */
  readonly pickerIsRegenerate = computed(() => {
    const variant = this.pickerVariant();
    return !!variant && this.hasAuthoritativeTranscript(variant);
  });

  formatMB(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  }

  /** True when the selected model still has to be downloaded (drives the hint). */
  pickerNeedsDownload(): boolean {
    const id = this.pickerModelId();
    if (!id) return false;
    return this.whisperModels().some(m => m.id === id && !m.present);
  }

  async openSentencePicker(v: ResolvedProjectVariant): Promise<void> {
    this.pickerError.set(null);
    this.pickerModelId.set(null);
    this.pickerVariant.set(v);
    // Component state must be known before defaulting the method (epub-align
    // requires the alignment engine); ensureLoaded is cached after first use.
    await this.components.ensureLoaded();
    // Default the method by ebook availability: when the project has an ebook
    // AND the alignment engine is installed, aligning its exact text is more
    // accurate than transcribing the audio.
    const ebooks = this.ebookVariants();
    if (ebooks.length > 0) {
      this.pickerMethod.set(this.alignEngineInstalled() ? 'epub-align' : 'whisper');
      // Seed the ebook choice either way so the option is ready if it enables.
      const primary = ebooks.find(e => e.id === this.primaryId()) ?? ebooks[0];
      this.pickerEpubId.set(primary.id);
    } else {
      this.pickerMethod.set('whisper');
      this.pickerEpubId.set(null);
    }
    // Ensure runtime state is fresh, then load models.
    await this.components.refresh();
    // The fresh probe may contradict the cached default (engine removed since).
    if (this.pickerMethod() === 'epub-align' && !this.alignEngineInstalled()) {
      this.pickerMethod.set('whisper');
    }
    await this.reloadWhisperModels();
  }

  closeSentencePicker(): void {
    this.pickerVariant.set(null);
  }

  private async reloadWhisperModels(): Promise<void> {
    const res = await this.electron.whisper.listModels();
    if (res.success && res.data) {
      this.whisperModels.set(res.data);
      // Default-select the first downloaded model, else the first in the catalog
      // (it downloads in the background when the job is queued).
      if (!this.pickerModelId() && res.data.length > 0) {
        const present = res.data.find(m => m.present);
        this.pickerModelId.set((present ?? res.data[0]).id);
      }
    } else {
      this.pickerError.set(res.error || 'Could not load the speech-to-text models.');
    }
  }

  async startGenerateSentences(v: ResolvedProjectVariant): Promise<void> {
    const method = this.pickerMethod();
    const pid = this.projectId();
    if (!pid) { this.pickerError.set('Could not resolve this project — try reopening it.'); return; }

    if (method === 'epub-align' && !this.pickerEpubId()) {
      this.pickerError.set('Pick an ebook to align first.'); return;
    }
    // Never queue an epub-align job without its engine — the runtime would
    // silently fall back to plain whisper.
    if (method === 'epub-align' && !this.alignEngineInstalled()) {
      this.pickerError.set('The ebook-alignment engine isn’t installed yet — install it above or switch to Whisper.');
      return;
    }

    // Both methods need a whisper model: whisper transcribes with it; epub-align
    // still runs a rough pass to anchor the alignment. In epub mode we don't make
    // the user choose — fall back to the smallest present model, else the first.
    let modelId = this.pickerModelId();
    if (!modelId) {
      if (method === 'whisper') { this.pickerError.set('Pick a model first.'); return; }
      const models = this.whisperModels();
      const present = models.filter(m => m.present).sort((a, b) => a.sizeMB - b.sizeMB)[0];
      modelId = (present ?? models[0])?.id ?? null;
      if (!modelId) { this.pickerError.set('No speech-to-text model is available.'); return; }
    }

    // The queue job owns ALL prerequisites: it installs the speech-to-text
    // engine if missing, downloads the model if missing (deduped with any dock
    // download), then transcribes. Nothing to pre-arrange here.
    // The path is the one main resolved for this row — never rebuilt here, and never
    // queued unverified: a job pointed at a nonexistent m4b would sit in the queue
    // and fail minutes later, far from this click.
    if (!v.absPath) {
      this.pickerError.set('BookForge has no resolved file path for this audiobook — reopen the book and try again.');
      return;
    }
    if (!v.exists) {
      this.pickerError.set(`This audiobook's file is not on disk: ${v.absPath}`);
      return;
    }
    const m4bPath = v.absPath;
    const modelLabel = this.whisperModels().find(m => m.id === modelId)?.label || modelId;
    await this.queue.addJob({
      type: 'generate-sentences',
      epubPath: m4bPath, // used only for the queue row's filename
      bfpPath: this.projectDir(),
      // Give the queue row a real identity: the book it transcribes + its author,
      // so it reads as "<Title> — <Author>" instead of "Untitled".
      metadata: {
        title: this.variantTitle(v),
        author: v.metadata?.author || '',
        year: v.metadata?.year,
        coverPath: v.metadata?.coverPath,
      },
      config: {
        type: 'generate-sentences',
        projectId: pid,
        variantId: v.id,
        m4bPath,
        modelId,
        modelLabel,
        language: v.metadata?.language || 'auto',
        method,
        ...(method === 'epub-align' ? { epubVariantId: this.pickerEpubId()! } : {}),
      },
    });
    const wasRegenerate = this.hasAuthoritativeTranscript(v);
    this.closeSentencePicker();
    await this.electron.showMessageDialog({
      title: 'Added to queue',
      message: (wasRegenerate
        ? 'Re-transcription was added to the queue — it replaces the current synced text when it runs. '
        : 'Transcription was added to the queue. ')
        + 'Open the Queue tab and press Start to run it.'
        + (this.pickerNeedsDownload() ? ' The job downloads the speech-to-text model first, then transcribes.' : ''),
      type: 'info',
    });
  }
}
