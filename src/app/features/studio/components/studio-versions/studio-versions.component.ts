import { Component, inject, input, output, signal, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService, WhisperModelStatus } from '../../../../core/services/electron.service';
import { ComponentService } from '../../../../core/services/component.service';
import { QueueService } from '../../../queue/services/queue.service';
import { VariantImportService } from '../../services/variant-import.service';
import { DiffViewComponent } from '../../../audiobook/components/diff-view/diff-view.component';
import { MetadataEditorComponent, EpubMetadata } from '../../../audiobook/components/metadata-editor/metadata-editor.component';
import { StudioItem } from '../../models/studio.types';
import { ProjectVariant } from '../../../../core/models/manifest.types';
import { DesktopSelectComponent, DesktopSelectItems } from '../../../../creamsicle-desktop';
import { StudioAnalysisTarget, studioManifestProjectId } from '../../analysis-target';

interface VersionRow {
  id: string; type: string; label: string; description: string;
  path: string; extension: string; language?: string;
  modifiedAt?: string; fileSize?: number; editable: boolean; icon: string;
  diffRecordPath?: string;   // presence => this version has a pre-computed diff to review
  diffOriginalPath?: string; // the original it was computed against (resolved locally, if it exists)
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
    @if (comparing(); as cmp) {
      <div class="compare-wrap">
        <div class="compare-bar">
          <button class="back" (click)="closeCompare()">← Back to versions</button>
          <span class="compare-title">{{ cmp.labelA }} <span class="vs">vs</span> {{ cmp.labelB }}</span>
        </div>
        <app-diff-view [originalPath]="cmp.a" [cleanedPath]="cmp.b" />
      </div>
    } @else {
      <div class="versions">
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
                      <button class="act" (click)="open.emit(variantAbsPath(v))" title="Open this file in the editor">Open</button>
                    }
                    <button class="act" (click)="exportDoc.emit(variantAbsPath(v))" title="Save a copy to your computer">Export</button>
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

        <!-- Documents (pipeline source versions) -->
        <div class="section-head">
          <span>Working files</span>
        </div>

        @if (loading()) {
          <div class="muted">Loading versions…</div>
        } @else if (documents().length === 0) {
          <div class="muted">No document versions yet.</div>
        } @else {
          @for (v of documents(); track v.id) {
            <div class="row" [class.clickable]="v.editable" (click)="onDocRowClick(v)">
              <span class="ricon">{{ v.icon || '\u{1F4C4}' }}</span>
              <div class="rinfo">
                <div class="rlabel">{{ v.label }} <span class="ext">.{{ v.extension }}</span></div>
                <div class="rdesc">{{ v.description }}{{ v.fileSize ? ' · ' + fmtSize(v.fileSize) : '' }}{{ v.modifiedAt ? ' · ' + fmtDate(v.modifiedAt) : '' }}</div>
              </div>
              <div class="ractions" (click)="$event.stopPropagation()">
                @if (hasSkippedReport(v)) { <button class="act" (click)="skipped.emit()">Skipped</button> }
                @if (hasDiffRecord(v)) {
                  <button class="act" (click)="startCompare(v)" title="Review the changes made to produce this version">Review Changes</button>
                }
                @if (isEpub(v) && !docIsAnalysisTarget(v)) {
                  <button class="act" (click)="emitGenerateAnalysisDoc(v)" title="Analyze this version for rhetorical manipulation and problematic patterns">Generate analysis</button>
                }
                @if (v.editable) {
                  <button class="act" (click)="edit.emit(v.path)" title="Open this file in the editor">Open</button>
                }
                <button class="act" (click)="exportDoc.emit(v.path)" title="Save a copy to your computer">Export</button>
                @if (deletable(v)) {
                  <button class="act danger" (click)="removeDoc(v)" title="Delete this version">Delete</button>
                }
                @if (v.type === 'original') {
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
                  <button class="act primary" (click)="listen.emit(variantAbsPath(v))"
                          title="Play this audiobook in the player window">Listen</button>
                  <button class="act" (click)="exportAudio.emit(variantAbsPath(v))"
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
    .section-head .add-version {
      margin-left: auto; text-transform: none; letter-spacing: 0;
      font-size: 0.78rem; font-weight: 600;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
      padding: 4px 10px; border-radius: 6px; cursor: pointer;
    }
    .section-head .add-version:hover:not(:disabled) { background: var(--bg-elevated); }
    .section-head .add-version:disabled { opacity: 0.5; cursor: default; }

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

  readonly bfpPath = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);

  readonly edit = output<string>();        // working-file path -> open editor (with project state)
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
  readonly comparing = signal<{ a: string; b: string; labelA: string; labelB: string } | null>(null);

  // Book variants (editions/languages/formats)
  readonly variantList = signal<ProjectVariant[]>([]);
  readonly transcriptEligibleVariantIds = signal<Set<string>>(new Set());
  readonly transcriptEligibilityKnown = signal(false);
  private variantLoadGeneration = 0;
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

  /** Book versions section: the reading editions only (ebooks). */
  readonly ebookVariants = computed(() => this.variantList().filter(v => v.kind === 'ebook'));

  /** Audio section: the audiobook editions — the single home for every M4B,
   *  whether uploaded via "+ Add version" or produced by TTS. */
  readonly audiobookVariants = computed(() => this.variantList().filter(v => v.kind === 'audiobook'));

  readonly documents = computed(() => this.versions().filter(v => v.type !== 'analysis'));

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

  emitGenerateAnalysisVariant(v: ProjectVariant): void {
    this.generateAnalysis.emit({
      kind: 'document', projectId: this.projectId(),
      versionId: v.id, versionType: v.kind, versionLabel: this.variantTitle(v),
      path: this.variantAbsPath(v),
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
    const bfp = this.bfpPath();
    if (!bfp) return;
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete analysis',
      message: 'Delete the content-analysis report for this book? This cannot be undone.',
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const res = await this.electron.deleteAnalysis(bfp);
    if (res.success) { await this.load(); this.changed.emit(); }
  }

  constructor() {
    // Only react to project/refresh changes. load() reads comparing() (to close an
    // open compare on item switch); without untracked() that read makes this effect
    // depend on comparing, so starting a compare would instantly re-run load() and
    // close it again — the compare view would never appear.
    effect(() => {
      this.bfpPath();
      this.refreshTrigger();
      untracked(() => void this.load());
    });

  }

  // ── Book variants ───────────────────────────────────────────────────────

  /** The manifest projectId — the last segment of the project directory path. */
  private projectId(): string {
    const item = this.item();
    if (item) return studioManifestProjectId(item);
    return this.bfpPath().split(/[\\/]/).filter(Boolean).pop() || '';
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
        this.variantList.set(res.variants as ProjectVariant[]);
        this.primaryId.set(res.primaryVariantId);
      } else {
        // A FAILED read (e.g. a transient manifest lock on a synced drive) is NOT
        // "this book has no versions" — do not wipe the list, or every version
        // appears to vanish. Keep what's shown and log; the next refresh retries.
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

  /** Absolute path to this variant's file (project dir + relative variant path). */
  variantAbsPath(v: ProjectVariant): string {
    const base = (this.bfpPath() || '').replace(/[\\/]+$/, '');
    return base ? `${base}/${v.path}` : v.path;
  }

  /** Clicking a pipeline document row opens it in the editor (its "edit feature").
   *  Variants open their inline details panel via the row's own toggleEditor. */
  onDocRowClick(v: VersionRow): void {
    if (v.editable) this.edit.emit(v.path);
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

  // 'exported' is deletable: it's the editor's working EPUB (source/exported.epub);
  // removing it just makes the pipeline fall back to the read-only archive source.
  // 'original'/'analysis' stay protected.
  deletable(v: VersionRow): boolean { return !['original', 'analysis'].includes(v.type); }

  async load(): Promise<void> {
    const bfp = this.bfpPath();
    // Leave any in-progress compare when the project changes or files refresh
    if (this.comparing()) this.closeCompare();
    this.openId.set(null);
    if (!bfp) { this.versions.set([]); this.variantList.set([]); return; }
    this.loading.set(true);
    try {
      const res = await this.electron.editorGetVersions(bfp);
      if (res.success && res.versions) {
        this.versions.set(res.versions as VersionRow[]);
      } else {
        // A FAILED read (e.g. a transient manifest lock on a synced drive) is NOT
        // "this book has no documents" — do not wipe the list, or every version
        // appears to vanish. Keep what's shown and log; the next refresh retries.
        // (Mirrors loadVariants below.)
        console.warn('[studio-versions] editorGetVersions failed; keeping current list:', res.error);
      }
    } catch (err) {
      console.warn('[studio-versions] editorGetVersions threw; keeping current list:', err);
    } finally {
      this.loading.set(false);
    }
    await this.loadCache(bfp);
    await this.loadVariants();
  }

  /** Read the durable TTS sentence cache for this project (if any) so the
   *  Versions list can show how much is rendered and offer Continue/Assemble/Delete. */
  private async loadCache(bfp: string): Promise<void> {
    this.cache.set(null);
    this.ttsVoice.set(null);
    const electron = (window as any).electron;
    if (!electron?.reassembly?.getBfpSession) return;
    try {
      const res = await electron.reassembly.getBfpSession(bfp);
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
    this.comparing.set({ a: original, b: v.path, labelA: 'Original', labelB: v.label });
    this.compareActive.emit(true);
  }

  closeCompare(): void {
    this.comparing.set(null);
    this.compareActive.emit(false);
  }

  async removeDoc(v: VersionRow): Promise<void> {
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete version',
      message: `Delete "${v.label}"? The original archived copy is not affected.`,
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const res = await this.electron.deleteFile(v.path);
    if (res.success) { await this.load(); this.changed.emit(); }
  }

  /**
   * Clear ALL persisted editor state for this project's source (deletions,
   * corrections, splits/merges, chapter markers, crops, category learning,
   * undo/redo) via the shared pipeline:reset-editor-state handler — the same
   * code path as Studio's context-menu reset. The archive/original file is
   * untouched. exported.epub deletion is opt-in and routed through the same
   * deleteFile mechanism removeDoc uses.
   */
  async resetEdits(): Promise<void> {
    const bfp = this.bfpPath();
    if (!bfp) return;

    // The exported working EPUB (if any) goes stale the moment edits are cleared.
    const exported = this.documents().find(d => d.type === 'exported');

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
      checkboxLabel: exported ? 'Also delete exported.epub' : undefined,
    });
    if (!confirmed) return;

    const res = await this.electron.resetEditorState(bfp);
    if (!res.success) {
      await this.electron.showMessageDialog({
        title: 'Reset failed',
        message: res.error || 'Could not reset editor state. Try again.',
        type: 'error',
      });
      return;
    }

    if (checkboxChecked && exported) {
      const del = await this.electron.deleteFile(exported.path);
      if (!del.success) {
        // Edits were reset, but the stale exported.epub survived (e.g. a transient
        // lock on the synced drive) — say so instead of implying it's gone.
        await this.electron.showMessageDialog({
          title: 'exported.epub not deleted',
          message: `Edits were reset, but exported.epub could not be deleted: ${del.error || 'unknown error'}. Delete it manually from the Versions list.`,
          type: 'warning',
        });
      }
    }

    await this.load();
    this.changed.emit();
  }

  /** Delete every cached sentence-audio file for this book (all languages). */
  async deleteCache(): Promise<void> {
    const bfp = this.bfpPath();
    if (!bfp) return;
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
      await electron?.pipeline?.deleteTtsCache?.(bfp);
    } finally {
      await this.load();
      this.changed.emit();
    }
  }

  fmtSize(b: number): string { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }
  fmtDate(iso: string): string { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleDateString(); }

  // ── Generate sentences (Whisper) ──────────────────────────────────────────

  readonly pickerVariant = signal<ProjectVariant | null>(null);
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

  async openSentencePicker(v: ProjectVariant): Promise<void> {
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

  async startGenerateSentences(v: ProjectVariant): Promise<void> {
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
    const m4bPath = this.variantAbsPath(v);
    const modelLabel = this.whisperModels().find(m => m.id === modelId)?.label || modelId;
    await this.queue.addJob({
      type: 'generate-sentences',
      epubPath: m4bPath, // used only for the queue row's filename
      bfpPath: this.bfpPath(),
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
