import {
  Component, DestroyRef, inject, input, output, signal, computed, effect, untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService, WhisperModelStatus } from '../../../../core/services/electron.service';
import { ComponentService } from '../../../../core/services/component.service';
import { NoticeService } from '../../../../core/services/notice.service';
import { QueueService, type DirectPassRunResult } from '../../../queue/services/queue.service';
import { VariantImportService } from '../../services/variant-import.service';
import { DiffViewComponent } from '../../../audiobook/components/diff-view/diff-view.component';
import { MetadataEditorComponent, EpubMetadata } from '../../../audiobook/components/metadata-editor/metadata-editor.component';
import { StudioItem } from '../../models/studio.types';
import {
  AppliedPass, AppliedPassKind, ProjectVariant, ResolvedProjectVariant, VersionsAudiobookFacts,
} from '../../../../core/models/manifest.types';
import { DesktopSelectComponent, DesktopSelectItems, DialogService } from '../../../../creamsicle-desktop';
import { StudioAnalysisTarget, studioManifestProjectId } from '../../analysis-target';
import type { PassDiffEntry } from '@shared/processing/pass-types';
import type { BookResetSummary } from '@shared/processing/reset-book';
import { samePath } from '@shared/document/same-path';
import { latestPassByKind } from '@shared/document/version-family';
import { StudioConvertModalComponent } from '../studio-convert-modal/studio-convert-modal.component';
import { BookConversionService, type ConversionSource } from '../../services/book-conversion.service';
import {
  NarrationDialogService, type NarrationEntryContext,
} from '../../services/narration-dialog.service';
import type { VlmConvertDestination } from '@shared/vlm/conversion';

/**
 * The content-analysis report row, as `versions:page-data` hands it over.
 *
 * This is all that survives of `editor:get-versions`. That handler measured the
 * whole document CHAIN — archive, working copy, cast, book, ledger, narration —
 * and Wave 1 (2026-08-16) stopped drawing every one of those rows; the flat page
 * read exactly ONE synthetic entry out of its answer, and this is it. The
 * handler was retired with the call on 2026-08-17.
 */
interface AnalysisRow {
  /** The analyzed file, absolute. Empty when the report is orphaned. */
  path: string;
  modifiedAt: string;
  flagCount: number;
  isCheckpoint: boolean;
  /** The durable version this report is pinned to. `versionId: null` is orphaned. */
  target: { versionId: string | null; versionType: string; versionLabel: string };
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
 * — but "Review changes" is the only way to see what a pass did, so it lives on
 * the badge rather than out of the app. Wave 1 (2026-08-16) removed the star
 * columns the book chain's own rows carried; the badges are the one way in to a
 * recorded diff now, so they carry every kind that left one.
 */
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
  // The digits-only strip over the book's own text — NOT the retired AI pass
  // above. Named differently on purpose: a user reading this book's history has
  // to be able to tell which of the two ran.
  'footnote-refs': 'Remove footnote references',
  // The text a voice reads: punctuation canonicalized, numbers read as words.
  // A book carries the stamp this pass wrote, and a render refuses one without.
  'narration-text': 'Narration text cleanup',
  // The other route to a book: a document vision model read the pages. A book's
  // ORIGIN like Build the book, not a transformation of one.
  'vlm-convert': 'Convert to EPUB',
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
  imports: [
    CommonModule, FormsModule, DiffViewComponent, MetadataEditorComponent, DesktopSelectComponent,
    StudioConvertModalComponent,
  ],
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
            <!-- The chunks an AI cleanup skipped or looped on. It used to hang
                 off the cleanup output's chain row; the report is about the
                 PROJECT's cleanup rather than about one version, so with the
                 chain gone it stands here beside the other project-wide act. -->
            @if (hasSkippedReport()) {
              <button class="start-over" (click)="skipped.emit()"
                      title="See the chunks the AI cleanup skipped or looped on">Skipped chunks</button>
            }
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
          <!--
            Said, never only logged — and said INSIDE the list it is about. The
            rows below are kept when a read fails (right for a transient lock on
            a synced drive), but a permanent failure would otherwise leave a
            stale or empty list on screen with no explanation. It stood above the
            "Book versions" head until 2026-08-18, where a failure to read the
            versions read as a failure of the whole page.
          -->
          @if (versionsError(); as e) {
            <div class="pass-err">{{ e }}</div>
          }
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
            <!-- ONE loop over a FLAT list, where an export's nesting under the
                 version it was made from is a CLASS rather than a second block
                 of markup. The row carries nine conditional actions; drawing
                 parents and children through two copies of it would mean every
                 future action has two places to be added to, and the one that
                 gets forgotten is always the nested one. See ebookRows(). -->
            @for (row of ebookRows(); track row.v.id) {
              @let v = row.v;
              <div class="vrow" [class.open]="openId() === v.id" [class.nested]="row.nested">
                <div class="vhead" (click)="toggleEditor(v)">
                  <span class="ricon">{{ variantIcon(v) }}</span>
                  <div class="rinfo">
                    <div class="rlabel">{{ variantTitle(v) }}</div>
                    <!-- WHAT THIS FILE IS, and the place it is SET.
                         Owen, 2026-08-18, on a rail that drew "Set primary" while
                         the title line beside it drew a "Primary" badge: the two
                         were one fact in two shapes at opposite ends of the row.
                         A chip states the fact and takes the press.

                         FILLED IS TRUE AND IS NOT PRESSABLE. Primary is a radio,
                         not a checkbox — a project has exactly one, and unsetting
                         it would leave getVariants to re-derive one silently. It
                         moves by pressing another version's hollow chip. -->
                    <div class="chips">
                      @if (isPrimary(v)) {
                        <span class="chip on"
                              title="The library, the shelf card and the web player show this version's cover, title and author, and this is the version the book opens as.">Primary</span>
                      } @else {
                        <button class="chip off" (click)="setPrimary(v); $event.stopPropagation()"
                                title="Make this the version the library, the shelf card and the web player show — its cover, title and author become the book's.">Primary</button>
                      }
                      @if (isTtsVariant(v)) {
                        <span class="chip on good" title="Narration reads this version">TTS file</span>
                      }
                      <!-- Owen, 2026-08-18: "change add to archive to something
                           like 'keep file'… the user is being asked if this should
                           be a definitive, final version of a file or if it's a
                           throwaway after tts is done."

                           So the chip says which it IS. output/ is cleared when a
                           book's output is deleted, so a Foundry export lives
                           there until the user says it is one of the book's own
                           files; pressing moves it into the protected archive/ and
                           un-nests the row. -->
                      @if (isFoundryExport(v)) {
                        <button class="chip warn" (click)="addToArchive(v); $event.stopPropagation()"
                                title="Temporary: this export lives in output/, which is cleared when this book's output is deleted. Press to keep it for good — the file moves into the archive as one of the book's own versions.">Temporary — keep</button>
                      }
                    </div>
                    <div class="rdesc">{{ variantSubtitle(v) }}</div>
                    @if (variantFilename(v); as fn) { <div class="rfile" [title]="fn">{{ fn }}</div> }
                    <!-- A conversion the user walked away from. The window is
                         closed; the run is not, and this is where it stays
                         visible — on the row whose pages are being read. -->
                    @if (conversion(); as run) {
                      @if (variantStartedConversion(v)) {
                        <div class="converting">
                          <div class="cbar" [class.waiting]="run.total === 0">
                            <div class="cfill" [style.width.%]="conversionPercent() < 0 ? 100 : conversionPercent()"></div>
                          </div>
                          <span class="ctext">
                            @if (run.total > 0) {
                              Reading the pages on {{ run.route }} — {{ run.done }} of {{ run.total }}
                            } @else {
                              Reading the pages on {{ run.route }} — starting
                            }
                          </span>
                        </div>
                      }
                    }
                  </div>
                  <!-- Owen, 2026-08-09: "from right to left, on every file -
                       delete, export, open. then, to the left of that are
                       special buttons, depending on whether the file is capable
                       of running the commands." That order is unchanged. What
                       changed on 2026-08-18 is everything else about the rail
                       ("i dont like the way they look"):

                       THE FACTS LEFT IT. Set primary and Keep permanently were
                       never verbs — see the chips above, which state what the
                       file is and take the press.

                       ONE ACT IS EMPHASIZED — the thing the row is FOR. Every
                       other verb is plain text until hovered, so a page of six
                       rows stops drawing twenty-one identical pills.

                       SAVE AND DELETE ARE ICONS, and that is what retired the
                       four-column grid. They are the only two acts on EVERY line,
                       so as the last two children of a right-aligned flex row
                       they align down the page by construction. The old grid held
                       them in line by reserving 78px columns and leaving them
                       EMPTY, which read as buttons that failed to load: Analysis
                       drew two such holes, the sentence cache drew two. A row
                       that cannot save now leaves a 26px gap nobody sees. -->
                  <div class="rail" (click)="$event.stopPropagation()">
                    <!-- A conversion started elsewhere (the book banner, the
                         queue) still has to be watchable from the row whose pages
                         are being read. Nothing STARTS one here. -->
                    @if (conversion() && variantStartedConversion(v)) {
                      <button class="quiet" (click)="showConversion()"
                              title="Watch the conversion, or stop it">Show progress</button>
                    }
                    <!-- ONE door into Foundry, and it is the PARENT file's.
                         An export opened in Foundry would start a second
                         project from a file that came out of the first. -->
                    <!-- The audio door. Owen, 2026-08-26: "Foundry is just for
                         text changes, not for audio changes." Plain rather than
                         the lead style, because Open is what an EPUB row is FOR
                         and one emphasized act per row is this rail's rule. -->
                    @if (canNarrate(v)) {
                      <button class="quiet" (click)="narrate(v, 'document')"
                              title="Read this version aloud, convert the voice, or assemble the audiobook">Narrate…</button>
                    }
                    @if (canOpenInFoundry(v) && !row.nested) {
                      <button class="act lead" (click)="openVariant(v)"
                              title="Open in Foundry">Open</button>
                    }
                    <button class="icon" (click)="exportVariant(v)"
                            title="Save a copy to your computer" aria-label="Save a copy to your computer">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7m0 0 3-3m-3 3L5 6" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></svg>
                    </button>
                    <button class="icon kill" (click)="remove(v)"
                            title="Delete this version" aria-label="Delete this version">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
                    </button>
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

        <!-- "Made in Foundry" stood here until 2026-08-17, as a group of its own
             holding rows that REFERENCED files in the foundry project's final/
             tray. It is gone, and so is the distinction it drew.

             Owen's ruling: "I think exports should go to the project as a
             version. The user can mark the file as a tts file if they want. I
             think the user should be able to send any EPUB through tts. I.e. it
             should have a process button if it's an epub file."

             So a Foundry export now LANDS as an ordinary version — copied into
             the book's archive/, minted as a variant, drawn by the loop above
             like every other version, and carrying Process because it is an
             EPUB. There is no second kind of row to keep a second group for. -->

        <!-- Analysis (content-analysis report — shown like a version, pinned to one) -->
        @if (analysisEntry(); as a) {
          <div class="section-head">Analysis</div>
          <div class="row">
            <span class="ricon">🔍</span>
            <div class="rinfo">
              <div class="rlabel">
                Content analysis
                @if (a.isCheckpoint) { <span class="ext">partial</span> }
              </div>
              <div class="rdesc">{{ analysisRowDesc(a) }}</div>
            </div>
            <div class="rail">
              <!-- No Regenerate and no View. Reading the report meant opening the
                   analyzed file in the legacy picker, which is where the flag
                   highlighting lived, and that window is unreachable since
                   2026-08-16 (Owen's ruling: Foundry is the one editing surface).
                   Owen, 2026-08-18: "Analysis is dead technically but i want to
                   revive it down the line. We can remove the button but leave the
                   logic. We'll rework it and add a button for it in the foundry
                   window later, next to translate and simplify."

                   So this row REPORTS what exists and lets it be saved or
                   removed. Nothing here starts an analysis — generateAnalysis
                   and its handlers are all still wired for the Foundry-side
                   button that replaces this one.

                   This is the line that used to draw two empty 78px columns to
                   stay in line with the rows above it. Now it draws two icons. -->
              @if (a.path) {
                <button class="icon" (click)="exportDoc.emit(a.path)"
                        title="Save a copy of the analyzed file" aria-label="Save a copy of the analyzed file">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7m0 0 3-3m-3 3L5 6" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></svg>
                </button>
              } @else {
                <span class="icon-gap"></span>
              }
              <button class="icon kill" (click)="removeAnalysis()"
                      title="Delete the content-analysis report" aria-label="Delete the content-analysis report">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
              </button>
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
            <div class="rail">
              <button class="quiet" (click)="correctSentences.emit()"
                      title="Listen to the rendered sentences and regenerate any that sound wrong, then rebuild">Correct sentences</button>
              <!-- ONE door for everything that can be done TO these sentences.
                   The modal opened in its cache context is the whole menu —
                   convert them through another voice, assemble them, or both —
                   so this row states the act and the modal states the plan. -->
              <button class="quiet" (click)="processFromCache()"
                      title="Convert these sentences through another voice, assemble them into an audiobook, or both">Process…</button>
              @if (!c.complete) {
                <button class="act lead" (click)="continueFromCache()"
                        title="Carry on rendering the remaining sentences">Continue</button>
              }
              <!-- The cache is not a file you can save a copy of — it is thousands
                   of per-sentence clips. The gap is what keeps Delete in the last
                   column, which is the whole reason the two trailing slots are
                   always rendered. -->
              <span class="icon-gap"></span>
              <button class="icon kill" (click)="deleteCache()"
                      title="Delete all cached sentence audio for this book" aria-label="Delete all cached sentence audio for this book">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
              </button>
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
                  <!-- A fact about the recording, stated and set in one place —
                       the ebook rows' reasoning, and this one had already half
                       become a chip: the button rendered its own state in its
                       label ("★ Professional" / "Mark professional"). Unlike
                       Primary this one IS pressable when filled, because it is a
                       genuine yes/no about one file rather than a designation
                       exactly one version has to hold. -->
                  <div class="chips">
                    <button class="chip" [class.on]="isProfessional(v)" [class.off]="!isProfessional(v)"
                            (click)="setProfessional(v, !isProfessional(v)); $event.stopPropagation()"
                            [title]="isProfessional(v) ? 'Marked professionally read — press to unset' : 'Mark as professionally read'">★ Professional</button>
                  </div>
                  <div class="rdesc">{{ variantSubtitle(v) }}</div>
                  @if (narratorFor(v); as nar) {
                    <div class="narrator" title="Who narrated this audiobook"><span class="nlabel">Narrator</span>{{ nar }}</div>
                  }
                  @if (variantFilename(v); as fn) { <div class="rfile" [title]="fn">{{ fn }}</div> }
                </div>
                <div class="rail" (click)="$event.stopPropagation()">
                  <!-- Analysis of the synced sentences stood here. It goes with
                       the document analysis for the same reason (2026-08-18):
                       the feature is being reworked and its door will be in
                       Foundry. emitGenerateAudiobookAnalysis and the queue
                       step behind it are untouched. -->
                  <!-- Owen: "generate sentences on every audio file. its been an
                       extremely important and useful tool." EVERY audio row
                       carries it. While the transcript check is still running
                       it is disabled with that as the reason rather than
                       missing — the two buttons it used to be were both hidden
                       in that window, so a row could show neither. -->
                  <button class="quiet" [disabled]="!transcriptEligibilityKnown()"
                          [title]="sentencesButtonTitle(v)"
                          (click)="openSentencePicker(v)">{{ sentencesButtonLabel(v) }}</button>
                  <button class="act lead" (click)="listenVariant(v)"
                          title="Play this audiobook in the player window">Listen</button>
                  <button class="icon" (click)="exportAudioVariant(v)"
                          title="Save a copy to your computer" aria-label="Save a copy to your computer">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7m0 0 3-3m-3 3L5 6" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></svg>
                  </button>
                  <button class="icon kill" (click)="remove(v)"
                          title="Delete the finished audiobook file (the rendered sentence cache is kept)" aria-label="Delete the finished audiobook file">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
                  </button>
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

    <!-- A window ONTO the conversion, never the conversion itself. Closing it
         backgrounds the run; the row keeps its indicator and opens this again. -->
    @if (convertModalOpen()) {
      <app-studio-convert-modal [projectDir]="projectDir()"
                                (close)="convertModalOpen.set(false)" />
    }

    <!-- The passes modal ("What should be done to this book?" — translate,
         simplify, footnotes, OCR repair, queue-or-run-now) stood here until
         2026-08-18, together with its options dialog and the narration dialog
         the Process button opened.

         Nothing opened the passes modal any more: Foundry is where text is made,
         and Owen ruled the same day that narration starts there too ("Tts should
         be done from inside foundry as well"). What is gone is this page's
         DOORS; every handler behind them still exists — the pass IPC, the queue
         steps, QueueService.submitProcessingRun / runProcessingRunNow, and
         NarrationModalComponent itself — so the Foundry-side buttons that
         replace them call the same code. -->
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

    /* What a pass that SUCCEEDED had to say — a ledger refusal, a narration-carry
       note, a count. Amber and banded so it is plainly not the red refusal above
       it, and wrapping in full: these sentences ARE the explanation, and one
       clipped to a line explains nothing. */
    .pass-notes {
      margin: 6px 4px;
      padding: 7px 9px;
      border-left: 2px solid var(--warning);
      background: var(--warning-bg);
      border-radius: 0 4px 4px 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pass-note {
      font-size: 0.78rem;
      line-height: 1.45;
      color: var(--warning-text);
      overflow-wrap: anywhere;
    }

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
    /* A conversion running with its window closed. Slim, on the row that
       started it, and it is the only thing on the page that moves. */
    .converting { margin-top: 6px; display: flex; align-items: center; gap: 9px; }
    .cbar { width: 140px; height: 4px; flex-shrink: 0; overflow: hidden; border-radius: 99px;
      background: var(--bg-elevated); }
    .cfill { height: 100%; border-radius: 99px; background: var(--accent-primary, #06b6d4);
      transition: width 0.25s ease-out; }
    .cbar.waiting .cfill { opacity: 0.35; }
    .ctext { overflow: hidden; color: var(--accent-primary, #06b6d4); font-size: 0.68rem;
      text-overflow: ellipsis; white-space: nowrap; }
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
    .vc-bar { flex: 1; height: 6px; background: var(--progress-track); border-radius: 3px; overflow: hidden; }
    .vc-fill { height: 100%; background: var(--progress-fill); transition: width 0.2s ease; }
    .vc-pct { color: var(--progress-value); font-weight: 600; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    .vrow {
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      border-radius: 8px; margin-bottom: 8px; background: var(--bg-elevated);
      overflow: hidden;
    }
    .vrow.open { border-color: var(--accent-primary, #06b6d4); }
    .vhead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; cursor: pointer; }
    /* A version Foundry made, drawn UNDER the version it was made from: indented
       and a size smaller. Owen, 2026-08-17: "visually be smaller indented line
       items under their parent file". SAME background and border as every other
       row — the first cut swapped in --bg-base (near-black in dark theme, a hole
       in the page) and a 2px --border-strong left rule with shrunken corner
       radii, and Owen called the result out on sight. The indent and the smaller
       type are the whole of the distinction. */
    .vrow.nested {
      margin-left: 26px;
    }
    .vrow.nested .vhead { padding: 7px 12px; }
    .vrow.nested .ricon { font-size: 1.05rem; }
    .vrow.nested .rlabel { font-size: 0.8rem; }
    .vrow.nested .rdesc { font-size: 0.7rem; }
    /* The .badge rules (Primary / TTS file, drawn inline after the title) stood
       here until 2026-08-18. The chips below took over both the shape and the
       job — the badge said the fact and a button at the far end of the row set
       it, and one fact drawn twice in two shapes is what the chips collapsed.
       .chip.on keeps the accent it used and .chip.on.good keeps its green, which
       was already deliberate: the TTS mark is a different KIND of fact from
       Primary, so it does not borrow the accent that means "this is the book". */
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
    /* THE RAIL: verbs only, right-aligned, one of them emphasized.

       Owen, 2026-08-09: "from right to left, on every file - delete, export,
       open. then, to the left of that are special buttons." That order still
       holds. What changed on 2026-08-18 is how it is HELD.

       It was a four-column grid — auto 78px 78px 78px — and a row that could
       not perform a standing act left its column empty. That is what kept the
       columns in line, and it is also what Owen was looking at when he said "i
       dont like the way they look": Analysis reserved two empty 78px columns,
       the sentence cache reserved two, and a reserved empty column reads as a
       button that failed to load rather than as alignment.

       The grid is gone because it is not needed. Save and Delete are the only
       two acts on EVERY line, so as the last two children of a right-aligned
       flex row they align down the page by construction — no reserved widths,
       and a line that cannot save leaves a 26px .icon-gap nobody sees. The
       facts that used to sit at the left of this cluster (Set primary, Keep
       permanently, Mark professional) are chips under the title now.

       It still wraps below the title on a narrow panel, because .rinfo keeps
       its flex-basis. */
    .rail { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    /* Held where a trailing icon would be, so Delete stays in the last column on
       a row that has nothing to save (the sentence cache). */
    .rail .icon-gap { width: 26px; flex: none; }
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
    .act:focus-visible { outline: 2px solid var(--accent-primary, #06b6d4); outline-offset: 2px; }
    .act.primary { background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff; }
    .act.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-primary, #06b6d4) 85%, #fff); }
    .act.danger:hover:not(:disabled) { background: color-mix(in srgb, #ef4444 20%, var(--bg-base)); border-color: #ef4444; }

    /* THE ONE EMPHASIZED ACT — what this row is FOR: Open on a book, Listen on a
       recording, Continue on a half-rendered cache. Exactly one per row, and it
       keeps the old 78px width so the emphasized buttons line up down the page
       even though nothing reserves a column for them any more. */
    .act.lead {
      background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff;
      font-weight: 600; min-width: 78px;
    }
    .act.lead:hover:not(:disabled) {
      background: color-mix(in srgb, var(--accent-primary, #06b6d4) 85%, #fff);
    }

    /* EVERY OTHER VERB — legible, present, and not competing. A bordered pill for
       each of these is what made six rows draw twenty-one identical controls; the
       hairline arrives on hover, where the pointer already is. */
    .quiet {
      font-family: inherit; font-size: 0.78rem; line-height: 1.2;
      background: none; border: 1px solid transparent; border-radius: 6px;
      color: var(--text-secondary); padding: 5px 9px; cursor: pointer;
      white-space: nowrap;
    }
    .quiet:hover:not(:disabled) {
      border-color: var(--border-default, rgba(255,255,255,0.12)); color: var(--text-primary);
    }
    .quiet:disabled { opacity: 0.45; cursor: default; }
    .quiet:focus-visible { outline: 2px solid var(--accent-primary, #06b6d4); outline-offset: 2px; }

    /* SAVE AND DELETE. Icons because they are the two acts every line has, so
       they are the two that can align without reserving anything — and because
       Delete at full pill strength on every row, in the position the eye stops,
       gave the act nobody wants the loudest place on the page. Both keep the
       titles they always had, and carry aria-labels for the same sentence. */
    .icon {
      width: 26px; height: 26px; flex: none; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: none; border: 1px solid transparent; border-radius: 6px;
      color: var(--text-secondary); cursor: pointer;
    }
    .icon svg {
      width: 16px; height: 16px; fill: none; stroke: currentColor;
      stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round;
    }
    .icon:hover {
      border-color: var(--border-default, rgba(255,255,255,0.12));
      color: var(--text-primary); background: var(--bg-base);
    }
    .icon:focus-visible { outline: 2px solid var(--accent-primary, #06b6d4); outline-offset: 2px; }
    .icon.kill:hover { border-color: #ef4444; color: #ef4444; }

    /* THE CHIPS: a fact about the file, in the one place it is also set.
       Filled says it is so; hollow-dashed says it is not and can be. Sized and
       spaced off .badge, which they replace — the badge shape is what the page
       already used for "what this version is". */
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
    .chip {
      font-family: inherit;
      font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: none; color: var(--text-secondary);
      white-space: nowrap; cursor: pointer;
    }
    .chip.off { border-style: dashed; }
    .chip.off:hover {
      color: var(--text-primary); border-color: var(--accent-primary, #06b6d4); border-style: solid;
    }
    /* Filled Primary is a <span>, not a button: a project has exactly one, so it
       moves by pressing another version's chip rather than by being switched off
       here. Professional is a genuine yes/no and stays pressable when filled. */
    span.chip.on { cursor: default; }
    .chip.on { background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff; }
    .chip.on.good { background: var(--success, #16a34a); }
    .chip.warn { border-color: var(--warning, #f59e0b); color: var(--warning, #f59e0b); border-style: dashed; }
    .chip.warn:hover { background: var(--warning, #f59e0b); color: var(--bg-base); border-style: solid; }
    .chip:focus-visible { outline: 2px solid var(--accent-primary, #06b6d4); outline-offset: 2px; }
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
    .compare-opening {
      margin: 8px 4px; padding: 14px 16px; border-radius: 8px;
      border: 1px solid var(--border-default); background: var(--bg-elevated);
      color: var(--text-secondary); font-size: 0.82rem; line-height: 1.5;
      white-space: pre-wrap;
    }
    .compare-opening.refused { color: var(--text-primary); border-color: var(--color-danger); }

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

    /* The book passes, one pressable card each. A whole row rather than a radio
       and a confirm: there is nothing to configure at this step, so choosing IS
       the act (and the two that do need configuring open their own dialog). */
    .gs-list { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
    .gs-choice {
      display: flex; flex-direction: column; gap: 3px; text-align: left;
      font-family: inherit; cursor: pointer;
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
    }
    .gs-choice:hover { border-color: var(--accent-primary, #06b6d4); }
    .gs-choice:disabled { opacity: 0.5; cursor: default; }
    .gs-choice-name { font-size: 0.86rem; font-weight: 600; }
    .gs-choice-note { font-size: 0.74rem; color: var(--text-secondary); line-height: 1.4; }

    /* WHEN the chosen pass runs. Two boxes rather than a checkbox: the two are
       genuinely different acts (one is watchable and cancellable, the other
       holds this window), and a checkbox would not say so. */
    .gs-when { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .gs-when-choice {
      display: flex; flex-direction: column; gap: 3px; text-align: left;
      font-family: inherit; cursor: pointer;
      padding: 9px 11px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: transparent; color: var(--text-secondary);
    }
    .gs-when-choice:hover { border-color: var(--accent-primary, #06b6d4); }
    .gs-when-choice.on {
      border-color: var(--accent-primary, #06b6d4);
      background: var(--bg-base); color: var(--text-primary);
    }
    .gs-when-choice:disabled { opacity: 0.5; cursor: default; }
    .pass-running { margin: 6px 4px; font-size: 0.78rem; color: var(--text-secondary); }
  `]
})
export class StudioVersionsComponent {
  private readonly electron = inject(ElectronService);
  private readonly components = inject(ComponentService);
  private readonly queue = inject(QueueService);
  private readonly imports = inject(VariantImportService);
  private readonly dialog = inject(DialogService);
  /** Where receipts go now that they no longer stop the user. See NoticeService. */
  private readonly notices = inject(NoticeService);

  readonly projectDir = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);
  readonly open = output<string>();         // abs path of the row's file -> open it in Foundry
  readonly exportDoc = output<string>();    // version path -> export EPUB/PDF
  readonly exportAudio = output<string>();  // abs path of the audiobook variant -> export the M4B
  readonly listen = output<string>();       // abs path of the audiobook variant to play
  readonly skipped = output<void>();        // open the skipped-chunks report panel
  /*
   * `continueJob` and `assemble` went with the Process wizard on 2026-08-27.
   * Both were requests to a PAGE — "open the Processing tab and do this there" —
   * and there is no such page now: the sentence-cache row opens the narration
   * modal itself, in the context that says which of the two the press meant.
   * What is left going out of this component is the one act that still has a
   * component of its own.
   */
  readonly correctSentences = output<void>(); // regenerate individual bad sentences, then rebuild
  readonly changed = output<void>();        // after delete/edit -> tell Studio to refresh
  readonly compareActive = output<boolean>(); // Studio goes full-height while comparing
  readonly generateAnalysis = output<StudioAnalysisTarget>(); // opens the analysis modal, locked to this source
  /**
   * The content-analysis report row, when this book has one.
   *
   * A SIGNAL now rather than a find() over a list of document rows. Wave 1
   * (2026-08-16) stopped drawing every other row `editor:get-versions` produced,
   * so what was left was a twelve-field list searched for one entry; the
   * consolidated `versions:page-data` sends that entry and nothing else.
   */
  readonly analysisEntry = signal<AnalysisRow | null>(null);
  readonly loading = signal(false);
  readonly cache = signal<SentenceCacheInfo | null>(null);
  // The TTS voice that rendered this project's audio (from the durable session's
  // provenance), used as the narrator for TTS audiobooks that have no explicit one.
  readonly ttsVoice = signal<string | null>(null);
  /**
   * What the tab is showing instead of the version list.
   *
   * ONE shape now: `pass` opens a recorded diff — the pass rewrote the book in
   * place, so neither side of it exists as a file any more and the diff carries
   * both texts. It is reached from a provenance badge's "Review changes".
   *
   * There were four. `paths` compared two FILES the chain's rows named, and
   * `books`/`opening` opened the two books a LEDGER entry sits between; all
   * three were doors on the book chain, and Wave 1 (2026-08-16) took the chain
   * off this page. Left as a discriminated union of one so the template keeps
   * reading `comparePass()` and adding a second surface stays a type change.
   */
  readonly comparing = signal<
    | { mode: 'pass'; diffPath: string; reportPath: string; title: string; when: string }
    | null
  >(null);
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
  /**
   * WHICH version the user marked as this book's TTS file, or undefined.
   *
   * A sibling of `primaryId` because it is the same kind of fact — a pointer the
   * manifest holds to ONE of these rows — and it arrives on the same call.
   */
  readonly ttsId = signal<string | undefined>(undefined);
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
   * Book versions section: EVERY reading edition this project holds.
   *
   * It used to subtract the rows the book chain was already drawing — the
   * archive original was both a manifest variant and a chain's parent, and
   * listing it in each put one file on screen twice under two different names.
   * Wave 1 (2026-08-16) took the chain off this page, so there is no second list
   * to be crossed with: the manifest's variant records ARE the versions, and
   * subtracting anything from them would hide a file the user owns.
   */
  readonly ebookVariants = computed(() =>
    this.variantList().filter(v => v.kind === 'ebook'));

  /**
   * The ebook versions in DISPLAY ORDER, each saying whether it is a nested row.
   *
   * Owen, 2026-08-17: "the exports should be moved to output and visually be
   * smaller indented line items under their parent file that was used to open
   * foundry originally."
   *
   * ── Why a FLAT list with a flag, and not a tree ─────────────────────────────
   *
   * The row markup is one block of forty lines carrying nine conditional
   * actions. Rendering parents and children through two copies of it — or
   * through an ng-template invoked twice — is two places for the next action to
   * be added to, and the one that gets forgotten is always the nested one. So
   * the NESTING IS A CLASS, not a structure: this flattens the parent/child
   * relation into the order the rows appear in, and the template draws one loop.
   *
   * ── When a parent cannot be found ───────────────────────────────────────────
   *
   * A row lands at TOP LEVEL when it has no `foundrySource`, when its
   * `parentVariantId` is null (the Foundry project was opened from a file that
   * is no version of this book), or when the parent it names is not among these
   * rows — deleted since, promoted out from under it, or an audiobook.
   *
   * That is a RENDERING answer to absent data, not a claim about provenance. The
   * record still says what it says; there is simply no row to sit under, and a
   * version drawn indented beneath an arbitrary neighbour would assert a
   * derivation nobody recorded. The `foundrySource` is untouched either way, so
   * a parent that comes back (an undo, a reload that finds the row) re-nests it.
   */
  readonly ebookRows = computed<{ v: ResolvedProjectVariant; nested: boolean }[]>(() => {
    const all = this.ebookVariants();
    const byId = new Map(all.map(v => [v.id, v]));
    const children = new Map<string, ResolvedProjectVariant[]>();
    const top: ResolvedProjectVariant[] = [];
    for (const v of all) {
      const parentId = v.foundrySource?.parentVariantId ?? null;
      // `parentId !== v.id` is not paranoia about corrupt data — it is the one
      // self-reference that would make the walk below never terminate.
      if (parentId !== null && parentId !== v.id && byId.has(parentId)) {
        const list = children.get(parentId);
        if (list) list.push(v); else children.set(parentId, [v]);
      } else {
        top.push(v);
      }
    }
    // Oldest landing first, so re-exports keep their place instead of the list
    // reshuffling every time Foundry writes one.
    for (const list of children.values()) {
      list.sort((a, b) =>
        (a.foundrySource?.landedAt ?? '').localeCompare(b.foundrySource?.landedAt ?? ''));
    }
    const rows: { v: ResolvedProjectVariant; nested: boolean }[] = [];
    // `seen` guards a cycle in the recorded parents. Nothing writes one today —
    // a parent is captured at import and an export is never another's parent —
    // but this walk is the only thing between a malformed manifest and a hung
    // renderer, and a version that appears once is a better failure than a page
    // that never paints.
    const seen = new Set<string>();
    const emit = (v: ResolvedProjectVariant, nested: boolean): void => {
      if (seen.has(v.id)) return;
      seen.add(v.id);
      rows.push({ v, nested });
      for (const c of children.get(v.id) ?? []) emit(c, true);
    };
    for (const v of top) emit(v, false);
    return rows;
  });

  /** Was this version landed by a Foundry export? (Cleared by "Add to archive".) */
  isFoundryExport(v: ProjectVariant): boolean {
    return !!v.foundrySource;
  }

  /** The version the user marked as this book's TTS file. */
  isTtsVariant(v: ProjectVariant): boolean {
    return !!this.ttsId() && v.id === this.ttsId();
  }

  /*
   * "Mark as TTS file" stood here (`canMarkTts` / `toggleTtsVariant`, both
   * removed 2026-08-18 with the button). The manifest pointer it wrote is still
   * read — see `isTtsVariant` above and `resolveTtsTarget` in main — so a book
   * marked before today still narrates the file it was pointed at.
   */

  /**
   * "Keep permanently" (called "Add to archive" until 2026-08-18): promote a
   * Foundry export to a top-level version.
   *
   * Owen, 2026-08-17: "an 'add to archive' button or something that moves it to
   * the top level." Renamed to say what it ASKS (Owen, 2026-08-18: "the user is
   * being asked if this should be a definitive, final version of a file or if
   * it's a throwaway after tts is done"); the act is unchanged. It MOVES the file out of output/ — which delete-output wipes
   * — into the protected archive/, and the version stops being drawn nested
   * because its provenance is cleared. No confirm: it is a move within the
   * project, Delete is still there, and the row does not go anywhere.
   */
  async addToArchive(v: ProjectVariant): Promise<void> {
    const pid = this.projectId();
    if (!pid) return;
    const res = await this.electron.variantPromoteToArchive(pid, v.id);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Could not add this to the archive',
        message: res.error || 'The file was not moved. Nothing was changed — try again.',
        type: 'error',
      });
      return;
    }
    this.notices.notify(
      `“${this.variantTitle(v)}” is now one of this book's own files. It moved out of output/, `
      + 'which is cleared when you delete a book\'s output.');
    await this.loadVariants();
    this.changed.emit();
  }

  /** Audio section: the audiobook editions — the single home for every M4B,
   *  whether uploaded via "+ Add version" or produced by TTS. */
  readonly audiobookVariants = computed(() => this.variantList().filter(v => v.kind === 'audiobook'));

  // ── Narration: the door came back on 2026-08-26 ───────────────────────────
  //
  // The Process button and the narration dialog it opened were retired on
  // 2026-08-18, when Owen ruled that a book is worked on in Foundry ("Tts should
  // be done from inside foundry as well"). He reversed the audio half of that on
  // 2026-08-26: *"Foundry is just for text changes, not for audio changes."*
  //
  // So Narrate is a door here again, and this page is the ONLY door that can
  // reach the runs Foundry's press cannot describe. A press over there is about
  // a document — it narrates the export it was made on. The two acts that are
  // about a book's AUDIO rather than its text (re-render the sentences already
  // cached through another voice, or just reassemble them) have no document to
  // be pressed on, and this page is where the sentence cache is listed.
  //
  // The dialog itself is hosted once, in the shell, and opened through
  // NarrationDialogService — Foundry's press has no route and no component
  // mounted, so hosting it at each door would be two copies of its wiring.
  //
  // "Mark as TTS file" did NOT come back. `ttsVariantId` is still read (the
  // shelf's Process button prefers a marked version, then the newest Foundry
  // export, then a sole EPUB); this page just does not offer to set it.

  private readonly narrationDialog = inject(NarrationDialogService);

  /**
   * Can this version be narrated — i.e. is it a book file?
   *
   * The dialog refuses a non-EPUB by name as well, because it is reachable from
   * Foundry too; this is what stops the button being drawn where it could only
   * refuse.
   */
  canNarrate(v: ResolvedProjectVariant): boolean {
    return v.kind === 'ebook' && this.variantExtension(v) === 'epub';
  }

  /**
   * Open the narration dialog on THIS version, through the door named.
   *
   * Owen's identity law, and the reason nothing is looked up here: "the tts
   * pipeline knows exactly which file its working with because the user came to
   * the tts page FROM the button on that document." The row IS a version and
   * carries its id, and `variantFile` has already proved the file is on disk —
   * so the target is complete before the dialog exists.
   *
   * The CONTEXT is a parameter, not a property of this method, because two
   * different rows call it: a version row means 'document' and the sentence
   * cache's Process means 'cache'. Guessing from the argument would be this
   * side inventing which press was made.
   */
  async narrate(v: ResolvedProjectVariant, context: NarrationEntryContext): Promise<void> {
    const abs = await this.variantFile(v, 'narrate this version');
    if (!abs) return;
    const dir = this.projectDir();
    if (!dir) {
      await this.electron.showMessageDialog({
        title: 'Could not narrate this version',
        message: 'This book has no project directory, so there is nowhere to put the rendered '
          + 'sentences or the finished audiobook.',
        type: 'error',
      });
      return;
    }
    const book = this.item();
    this.narrationDialog.open({
      epubPath: abs,
      variantId: v.id,
      projectDir: dir,
      // The VERSION's own metadata where it has any, and the book's otherwise:
      // a version row is what the user pressed, and its title is what the
      // audiobook should be tagged with.
      title: v.metadata?.title || book?.title || '',
      author: v.metadata?.author || book?.author || '',
      year: v.metadata?.year || book?.year || '',
      coverPath: book?.coverPath || '',
      outputFilename: book?.outputFilename || '',
      isArticle: book?.type === 'article',
    }, context);
  }

  /**
   * WHICH VERSION a press on the sentence-cache row is filed against.
   *
   * The cache is not a version — it is thousands of clips rendered FROM one —
   * so a run started here still has to name the version it belongs to. The rule
   * is `ttsTarget`'s, the same resolution the shelf's own Process button makes:
   * the version marked as the TTS file, and otherwise any EPUB this book has.
   * Null means there is nothing honest to name, and the caller says so in the
   * words its own button earned.
   */
  private cacheRowVariant(): ResolvedProjectVariant | null {
    return this.variantList().find((v) => this.isTtsVariant(v) && this.canNarrate(v))
      ?? this.variantList().find((v) => this.canNarrate(v))
      ?? null;
  }

  /**
   * PROCESS, pressed on the SENTENCE CACHE row — the door for cache-only runs.
   *
   * It opens the same dialog on the same book, in the 'cache' context: the run
   * is about audio that already exists, so the modal locks its Reading tab off
   * and opens on Assembly.
   *
   * ONE BUTTON now, where there were two (Owen, 2026-08-27: *"erase the
   * assemble/narrate buttons and replace it with a single button that opens the
   * modal"*). Assemble left for a Processing tab that no longer exists, and
   * Narrate… opened this same dialog without saying which door it came through
   * — so the row asked one question twice and neither answer named the run.
   */
  async processFromCache(): Promise<void> {
    const target = this.cacheRowVariant();
    if (!target) {
      await this.electron.showMessageDialog({
        title: 'Could not process this book',
        message: 'This book has no EPUB version, so a run over its cached sentences has nothing '
          + 'to file itself against. Export or add an EPUB version first.',
        type: 'warning',
      });
      return;
    }
    await this.narrate(target, 'cache');
  }

  /**
   * CONTINUE, pressed on a part-finished sentence cache.
   *
   * The same dialog in the 'document' context — because carrying on IS reading
   * the book, from wherever the last run stopped, and that is the one thing the
   * cache context forbids. The modal's own resume block is the continue flow
   * now: it finds the part-finished render, says how many sentences are already
   * on disk, and opens with "Carry on from there" chosen. That offer used to be
   * implemented a second time inside the Process wizard (its Continue mode,
   * pre-filling the original run's settings from `checkResumeFromDir`); the
   * wizard is gone and the dialog's version is the one that survived.
   */
  async continueFromCache(): Promise<void> {
    const target = this.cacheRowVariant();
    if (!target) {
      await this.electron.showMessageDialog({
        title: 'Could not continue this narration',
        message: 'This book has no EPUB version, so the narration has nothing to carry on '
          + 'reading. Export or add an EPUB version first.',
        type: 'warning',
      });
      return;
    }
    await this.narrate(target, 'document');
  }

  // ── Watching the book being made ───────────────────────────────────────────
  //
  // A PDF became a book HERE until 2026-08-18, from a "Convert to EPUB" button
  // on the PDF version's own row. Owen: "no more convert to epub button. Thats
  // done inside foundry."
  //
  // What stays is the WINDOW onto a conversion, because a run started elsewhere
  // (the book banner, a queue row) is still this project's and still belongs on
  // the row whose pages are being read. Nothing here starts one; the machinery
  // (`BookConversionService`, `vlm:convert`, the queue step) is untouched.

  private readonly conversions = inject(BookConversionService);

  /** The conversion running for this project, or null. Drives the row and modal. */
  readonly conversion = computed(() => this.conversions.runFor(this.projectDir()));
  /** The progress window is open. Closing it leaves the run going. */
  readonly convertModalOpen = signal(false);

  /** The version's format, lowercased, from the record main resolved it into. */
  variantExtension(v: ProjectVariant): string {
    return ((v.format || '') || this.variantFilename(v).split('.').pop() || '').toLowerCase();
  }

  /** Re-open the window onto a conversion that is already running. */
  showConversion(): void { this.convertModalOpen.set(true); }

  /**
   * Is the live conversion the one THIS row started?
   *
   * Matched on the VERSION id the run was prepared with, never on its label: two
   * versions of one book can share a title, and a progress bar drawn on the
   * wrong row attributes an hour of GPU to a document it never read. A run with
   * no version id came from a queue row and belongs to no row here.
   */
  variantStartedConversion(v: ProjectVariant): boolean {
    const run = this.conversion();
    return run !== null && run.variantId === v.id;
  }

  /** How far along, for the row's own slim bar. -1 while there is no count yet. */
  conversionPercent(): number {
    const run = this.conversion();
    if (!run || run.total <= 0) return -1;
    return Math.min(100, Math.round((run.done / run.total) * 100));
  }

  /** Did an AI cleanup on this project record chunks it skipped or looped on? */
  readonly hasSkippedReport = computed(() => !!this.item()?.skippedChunksPath);

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
    // Every kind a book can carry, in the order they would have happened. The
    // retired ones are listed BECAUSE they are retired: a manifest is a book's
    // own history, and the badges are the only place a book processed before
    // Aug 2026 can still say how it was made. A kind missing from this list has
    // no badge at all, which would silently shorten a real book's history —
    // `reflow`, `get-text` and `blocks` were missing exactly that way.
    const order: AppliedPassKind[] = [
      'vlm-convert',
      'tesseract', 'get-text', 'ocr-correction', 'blocks', 'detection', 'reflow',
      'footnotes', 'simplify', 'translate'];
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
      //
      // EVERY kind's diff is behind its badge now. The star columns on the book
      // chain's own rows used to carry most of them (Owen, third session: the
      // diff "should be linked to the file it was applied to"), and the badge
      // deliberately did not offer a second door onto the same diff. Wave 1
      // (2026-08-16) took the chain off this page and the stars with it, so a
      // kind excluded here would be a recorded diff with no door at all.
      const ofKind = diffs.filter(d => d.kind === kind);
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
  /** The durable version id the report is pinned to (null when orphaned). */
  readonly analysisTargetId = computed(() => this.analysisEntry()?.target.versionId ?? null);

  /** One-line summary for the Analysis item: flag count + which version it's pinned to. */
  analysisRowDesc(a: AnalysisRow): string {
    const t = a.target;
    const attached = t.versionId
      ? `on ${t.versionLabel || 'a version'}`
      : 'analyzed version no longer available';
    const parts = [`${a.flagCount} flag${a.flagCount !== 1 ? 's' : ''} · ${attached}`];
    if (a.modifiedAt) parts.push(this.fmtDate(a.modifiedAt));
    return parts.join(' · ');
  }

  /** Re-run the analysis on the same version it's currently pinned to. */
  regenerateAnalysis(a: AnalysisRow): void {
    const t = a.target;
    if (!t.versionId) return; // orphaned report — nothing to re-target
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

    // ── What the Foundry window files, while it is filing it ────────────────
    //
    // An export made in the Foundry window is landed by main as a VERSION of the
    // book it belongs to, and this page is very likely open on that book at the
    // time — the user pressed Edit in Foundry from here. So the row appears when
    // the file does, without a reload and without this page polling anything.
    //
    // The WHOLE page reloads, where the retired export list re-read only itself.
    // That is not a regression: what changed is the variant list, and `load()` is
    // the one thing that re-measures it (`loadVariants` is private to it and the
    // row's own file resolution comes with it). The old narrow re-read existed to
    // avoid yanking the page for a file that appeared in a group nobody was
    // working in; a landing now changes a row the user can act on immediately.
    const unwatchExports = this.electron.onFoundryVersionsChanged((event) => {
      const dir = this.projectDir();
      if (dir === '') return;
      if (!samePath(event.projectDir, dir)) return;
      void this.load();
    });
    inject(DestroyRef).onDestroy(unwatchExports);

    // ── The slow audiobook facts, when main has finished working them out ────
    //
    // `versions:page-data` answers from the derivation cache and does not wait
    // for a fact it does not have: it says `deriving` and works it out behind
    // the page. This is where that answer arrives. Nothing else about the page
    // is re-read — what changed is which audiobooks have a transcript, which is
    // exactly what these two signals hold.
    //
    // The projectId is CHECKED. The broadcast goes to every window, and a book
    // the user has already navigated away from still finishes its derivation;
    // folding its answer in here would mark another book's audiobooks eligible.
    const unwatchFacts = this.electron.onVersionsAudiobookFacts((event) => {
      if (event.projectId !== this.projectId()) return;
      this.applyAudiobookFacts(event.audiobooks);
    });
    inject(DestroyRef).onDestroy(unwatchFacts);

    // An export from a Foundry project no book of ours claims. Main recorded
    // NOTHING — said here rather than swallowed, because the file exists and the
    // user is entitled to know it went nowhere and why.
    const unwatchUnmatched = this.electron.onFoundryUnmatchedExport((event) => {
      this.notices.notify(
        `Foundry exported “${event.title}” from a project (${event.key}) that no book in this `
        + 'library is linked to, so it was not added to any book. Open the book with '
        + '“Import via Foundry” once so the link is made, then export again.');
    });
    inject(DestroyRef).onDestroy(unwatchUnmatched);
  }

  // ── Book variants ───────────────────────────────────────────────────────

  /** The manifest projectId — the last segment of the project directory path. */
  private projectId(): string {
    const item = this.item();
    if (item) return studioManifestProjectId(item);
    return this.projectDir().split(/[\\/]/).filter(Boolean).pop() || '';
  }

  /**
   * The page's ONE entry call, and what it does with each half of the answer.
   *
   * Owen, 2026-08-17: "opening any book's versions page takes 5-10 seconds."
   * This used to be two IPCs, and the second of them — `analysis:list-audiobooks`
   * — SHA-256'd every multi-gigabyte audiobook in the book on every visit just to
   * decide whether the Generate sentences button should be enabled. Measured on
   * the real library that was 4.0-9.6 s of a 4.5-9.7 s page load.
   *
   * `versions:page-data` answers everything stat-level at once. The audiobook
   * facts it cannot answer from main's derivation cache come back marked
   * `deriving` and land later on the broadcast this component subscribes to in
   * its constructor — so the rows are on screen immediately and the one button
   * that depends on a slow fact says it is still checking, exactly as it did
   * before, but for a second instead of ten.
   *
   * Still called `loadVariants` by every act that changes a variant (set primary,
   * delete, save metadata) because that is still what it does for them: re-read
   * this book's rows.
   */
  private async loadVariants(): Promise<void> {
    const generation = ++this.variantLoadGeneration;
    const pid = this.projectId();
    if (!pid) {
      this.variantList.set([]);
      this.primaryId.set(undefined);
      this.ttsId.set(undefined);
      this.analysisEntry.set(null);
      this.transcriptEligibleVariantIds.set(new Set());
      this.transcriptEligibilityKnown.set(false);
      return;
    }
    this.transcriptEligibilityKnown.set(false);
    try {
      const res = await this.electron.versionsPageData(pid);
      if (generation !== this.variantLoadGeneration || this.projectId() !== pid) return;
      if (!res.success || !res.variants) {
        // A FAILED read (e.g. a transient manifest lock on a synced drive) is NOT
        // "this book has no versions" — do not wipe the list, or every version
        // appears to vanish. Keep what's shown and say so; the next refresh
        // retries. This only ever keeps rows for the SAME project: the generation
        // guard above discards a superseded load, and load() clears the lists
        // synchronously when the selected book changes, so there is never another
        // book's row left here to be kept.
        console.warn('[studio-versions] versionsPageData failed; keeping current list:', res.error);
        this.versionsError.set(
          `This book's versions could not be read, so what's below may be out of date: `
          + `${res.error || 'no reason given'}`);
        return;
      }
      // Each row carries the absPath main resolved against THIS project's dir.
      this.variantList.set(res.variants);
      this.primaryId.set(res.primaryVariantId);
      this.ttsId.set(res.ttsVariantId);
      this.analysisEntry.set(res.analysis ?? null);
      this.versionsError.set(null);
      this.applyAudiobookFacts(res.audiobooks ?? []);
    } catch (err) {
      console.warn('[studio-versions] versionsPageData threw; keeping current list:', err);
      this.versionsError.set(
        `This book's versions could not be read, so what's below may be out of date: `
        + `${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Fold main's audiobook facts into the two signals the buttons read.
   *
   * The rule this encodes, and the reason it is one function rather than two
   * assignments at each call site: an audiobook whose transcript is still being
   * checked is NOT an audiobook without one. It stays out of the eligible set
   * (so nothing claims it has synced text) AND holds `transcriptEligibilityKnown`
   * down (so the button is drawn disabled, saying the check is running, rather
   * than offering to transcribe over a transcript that may already be inside the
   * file). Only when every audiobook has a settled answer does the page act on
   * what it knows.
   */
  private applyAudiobookFacts(facts: VersionsAudiobookFacts[]): void {
    this.transcriptEligibleVariantIds.set(
      new Set(facts.filter(f => f.transcript === 'eligible').map(f => f.variantId)));
    this.transcriptEligibilityKnown.set(facts.every(f => f.transcript !== 'deriving'));
  }

  /**
   * Who narrated an audiobook: its own narrator metadata (user-set, or from an
   * imported file's tag) if present, else — for a TTS RENDER ONLY — the voice
   * that rendered it.
   *
   * `ttsVoice` is a PROJECT-wide fact: one voice, read from the durable TTS
   * session's provenance. Handing it to every audiobook without narrator
   * metadata credited a human reading to whatever model last rendered the same
   * book — Owen's own reading of God's People was shown as narrated by
   * `thirdreich` because a TTS version of the book exists alongside it.
   *
   * `professionallyRead` is the test, and it is a definite boolean here:
   * `getVariants()` stamps one on every audiobook variant. A professionally
   * read version with no narrator tag has no answer, and says nothing rather
   * than borrowing one.
   */
  narratorFor(v: ProjectVariant): string {
    const own = (v.metadata?.narrator || '').trim();
    if (own) return own;
    if (v.professionallyRead) return '';
    return (this.ttsVoice() || '').trim();
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
        message: `BookForge has no file path for the “${this.variantTitle(v)}” version, so there `
          + 'is nothing to act on. Nothing was changed. Reopen the book, and report this if it '
          + 'happens again.',
        type: 'error',
      });
      return null;
    }
    if (!v.exists) {
      console.error(`[variantFile] ${action}: file missing on disk: ${v.absPath}`);
      await this.electron.showMessageDialog({
        title: `Could not ${action}`,
        message: `The file for the “${this.variantTitle(v)}” version is not on disk — see the log `
          + 'for the path. It may have been moved, deleted, or not yet synced to this machine.',
        type: 'error',
      });
      return null;
    }
    return v.absPath;
  }

  /**
   * Open this version's own file in Foundry — the one editing surface since
   * 2026-08-16.
   *
   * The row names a FILE, so the press lands on that file: the same
   * `variantFile`-proved absolute path Process carries, handed to Foundry's
   * document deep-link. A file that lies inside the book's Foundry project
   * adopts into it there; one that does not is still opened, through the same
   * admission door a drop uses.
   */
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

  /** Foundry edits documents — EPUB and PDF. Audio (m4b) and other formats have
   *  nothing to open there, so no Open button for them. */
  canOpenInFoundry(v: ProjectVariant): boolean {
    if (v.kind !== 'ebook') return false;
    const ext = this.variantExtension(v);
    return ext === 'epub' || ext === 'pdf';
  }

  variantSubtitle(v: ProjectVariant): string {
    // Descriptor now lives in the title (in parentheses), so it's dropped here.
    const parts: string[] = [];
    if (v.format) parts.push(v.format.toUpperCase());
    if (v.metadata?.author) parts.push(v.metadata.author);
    if (v.metadata?.language) parts.push(v.metadata.language);
    // WHERE it came from and WHEN, on the row rather than only in the indent: an
    // export nested under a parent that has scrolled away is otherwise an
    // unexplained duplicate of the book. Said for exports only — every other
    // version is one the user put there themselves and needs no provenance line.
    if (v.foundrySource) {
      const at = new Date(v.foundrySource.landedAt);
      parts.push(isNaN(+at) ? 'Made in Foundry' : `Made in Foundry ${at.toLocaleString()}`);
    }
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

  // ── Made in Foundry (RETIRED 2026-08-17) ──────────────────────────────────
  //
  // The signals and the six methods that drew the export rows lived here:
  // `foundryExports` / `foundryExportsError`, `loadFoundryExports`,
  // `foundryExportIcon`, `foundryExportDesc`, `openFoundryExport`,
  // `exportFoundryExport`, `removeFoundryExport`.
  //
  // All of it is gone because the thing it drew is gone. A Foundry export is not
  // a reference to a file in Foundry's tray any more — it is COPIED into the
  // book's archive/ and minted as an ordinary variant (see
  // `landFoundryExportAsVariant`, electron/library-actions.ts), so it is drawn,
  // opened, exported and deleted by the version machinery above and needs no
  // second set of anything.
  //
  // The READ machinery on the main side (`foundry-host:exports`,
  // `foundry-host:forget-export`, `readFoundryExports`, `appendFoundryExport`,
  // `forgetFoundryExport` and the `foundryExports[]` manifest field) went with
  // it in the deletion wave. The records a library already holds are NOT
  // migrated and are no longer read — there is at most a night's worth of them,
  // they name files that are still in Foundry's tray, and re-exporting from
  // Foundry lands each one properly as a version.

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
      // The per-file reasons are a list, and a list is a log. The banner says
      // how many so the user knows to go and look.
      console.warn(`[variantAdd] ${errors.length} file(s) were not added: ${errors.join(' | ')}`);
      this.notices.notify(
        `${errors.length} of the files you chose were not added — see the log for which. `
        + 'The rest are on this book\'s versions list.',
      );
    }
    if (this.projectId() !== pid) return;
    // Both halves of the page: the variant list AND the Documents family —
    // an added PDF mints an archive row, and Convert to EPUB stands on it.
    await this.load();
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
    const { paths, unlocatable } = this.electron.pathsForFiles(files);
    if (unlocatable.length > 0) {
      this.notices.notify(
        `Not added — ${unlocatable.join(', ')} ${unlocatable.length === 1 ? 'is' : 'are'} ` +
        `not a file on this machine. Drop versions in from a folder, not from a web page.`
      );
    }
    if (paths.length) void this.addFiles(paths);
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
      this.analysisEntry.set(null);
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
      // The page's rows, FIRST and in one call. Everything after this is a
      // detail hanging off a row that is already drawn — the sentence cache
      // line, the provenance badges, whether Start over has anything to remove
      // — so none of them stands between the user and the versions.
      await this.loadVariants();
      if (superseded()) return;
    } finally {
      // Only the load that still owns the UI may clear the spinner — otherwise
      // this one's exit would say "done" about a newer book that is still loading.
      if (!superseded()) this.loading.set(false);
    }
    if (superseded()) return;
    await this.loadCache(dir, superseded);
    if (superseded()) return;
    await this.loadPassDiffs(dir, superseded);
    if (superseded()) return;
    await this.loadResetPlan(dir, superseded);
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
          + `${blocking.length > 1 ? ` — and ${blocking.length - 1} more` : ''}. Nothing was `
          + 'deleted. Let it finish or remove it from the Queue, then start over.',
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

  closeCompare(): void {
    this.comparing.set(null);
    this.passReport.set(null);
    this.compareActive.emit(false);
  }

  /**
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

  /**
   * What the sentences button on an audio row is CALLED.
   *
   * One button on every audio row, and it says which act it is: an audiobook
   * with synced text already is RE-transcribed, and saying so is the difference
   * between adding text and replacing it. It used to be two buttons behind two
   * predicates, and the window in which the transcript check had not answered
   * yet showed NEITHER — a row with no way to do the thing Owen calls "an
   * extremely important and useful tool".
   */
  sentencesButtonLabel(v: ProjectVariant): string {
    return this.hasAuthoritativeTranscript(v) ? 'Regenerate sentences' : 'Generate sentences';
  }

  sentencesButtonTitle(v: ProjectVariant): string {
    if (!this.transcriptEligibilityKnown()) {
      return 'BookForge is still checking whether this audiobook already has synced text. It would '
        + 'not be said which act this is until that comes back, and re-transcribing a book that '
        + 'already has text replaces it.';
    }
    return this.hasAuthoritativeTranscript(v)
      ? 'Re-transcribe this audiobook, replacing the current synced text'
      : 'Transcribe this audiobook into synced on-screen text';
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
    this.notices.notify(
      (wasRegenerate
        ? 'Re-transcription was added to the queue — it replaces the current synced text when it runs. '
        : 'Transcription was added to the queue. ')
      + 'Open the Queue tab and press Start to run it.'
      + (this.pickerNeedsDownload() ? ' The job downloads the speech-to-text model first.' : ''),
    );
  }
}
