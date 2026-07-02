import { Component, inject, input, output, signal, computed, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../../../core/services/electron.service';
import { DiffViewComponent } from '../../../audiobook/components/diff-view/diff-view.component';
import { MetadataEditorComponent, EpubMetadata } from '../../../audiobook/components/metadata-editor/metadata-editor.component';
import { StudioItem } from '../../models/studio.types';
import { ProjectVariant } from '../../../../core/models/manifest.types';

interface VersionRow {
  id: string; type: string; label: string; description: string;
  path: string; extension: string; language?: string;
  modifiedAt?: string; fileSize?: number; editable: boolean; icon: string;
  diffRecordPath?: string;   // presence => this version has a pre-computed diff to review
  diffOriginalPath?: string; // the original it was computed against (resolved locally, if it exists)
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
  imports: [CommonModule, FormsModule, DiffViewComponent, MetadataEditorComponent],
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
          @if (variants().length === 0) {
            <div class="vempty">
              Drop an audiobook or ebook here — or click <b>Add version</b> — to add another
              edition, language, or format of this book.
            </div>
          } @else {
            @for (v of variants(); track v.id) {
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
                    @if (canOpenInEditor(v)) {
                      <button class="act" (click)="open.emit(variantAbsPath(v))" title="Open this file in the editor">Open</button>
                    }
                    @if (!isPrimary(v)) {
                      <button class="act" (click)="setPrimary(v)" title="Make this the version that represents the project">Set primary</button>
                    }
                    <button class="act" (click)="toggleEditor(v)">{{ openId() === v.id ? 'Close' : 'Edit' }}</button>
                    <button class="act danger" (click)="remove(v)">Delete</button>
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
            <div class="row">
              <span class="ricon">{{ v.icon || '\u{1F4C4}' }}</span>
              <div class="rinfo">
                <div class="rlabel">{{ v.label }} <span class="ext">.{{ v.extension }}</span></div>
                <div class="rdesc">{{ v.description }}{{ v.fileSize ? ' · ' + fmtSize(v.fileSize) : '' }}{{ v.modifiedAt ? ' · ' + fmtDate(v.modifiedAt) : '' }}</div>
              </div>
              <div class="ractions">
                @if (v.editable) { <button class="act" (click)="edit.emit(v.path)">Edit</button> }
                @if (hasDiffRecord(v)) { <button class="act" (click)="startCompare(v)" title="Review the changes made to produce this version">Review Changes</button> }
                @if (hasSkippedReport(v)) { <button class="act" (click)="skipped.emit()">Skipped</button> }
                <button class="act" (click)="exportDoc.emit(v.path)">Export…</button>
                @if (deletable(v)) { <button class="act danger" (click)="removeDoc(v)">Delete</button> }
              </div>
            </div>
          }
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
              @if (!c.complete) {
                <button class="act primary" (click)="continueJob.emit()"
                        title="Resume rendering the remaining sentences in the Processing tab, with the same settings as before">Continue</button>
              }
              <button class="act" (click)="assemble.emit()"
                      title="Assemble the cached sentences into a finished audiobook in the Processing tab">Assemble</button>
              <button class="act danger" (click)="deleteCache()" title="Delete all cached sentence audio for this book">Delete cache</button>
            </div>
          </div>
        }

        <!-- Audio outputs -->
        @if (audioRows().length > 0) {
          <div class="section-head audio">Audio</div>
          @for (a of audioRows(); track a.key) {
            <div class="row">
              <span class="ricon">\u{1F3A7}</span>
              <div class="rinfo">
                <div class="rlabel">{{ a.label }}</div>
                <div class="rdesc">{{ a.desc }}</div>
              </div>
              <div class="ractions">
                <button class="act primary" (click)="listen.emit()">Listen</button>
                <button class="act" (click)="exportAudio.emit()">Export…</button>
                @if (a.mono) {
                  @if (item()?.vttPath) { <button class="act" (click)="fixChapters.emit()">Fix Chapters</button> }
                }
              </div>
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
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
    .vrow {
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      border-radius: 8px; margin-bottom: 8px; background: var(--bg-elevated);
      overflow: hidden;
    }
    .vrow.open { border-color: var(--accent-primary, #06b6d4); }
    .vhead { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; }
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
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.07));
      margin-bottom: 8px; background: var(--bg-elevated);
    }
    .row.dim { opacity: 0.4; }
    .ricon { font-size: 1.3rem; flex-shrink: 0; }
    .rinfo { flex: 1; min-width: 0; }
    .rlabel { font-size: 0.88rem; font-weight: 600; color: var(--text-primary); }
    .ext { font-size: 0.72rem; color: var(--text-secondary); font-weight: 400; }
    .rdesc { font-size: 0.74rem; color: var(--text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Filename wraps (word-break) rather than truncating, so the extension — the
       whole point of showing it — is never hidden behind an ellipsis. */
    .rfile { font-size: 0.7rem; color: var(--text-secondary); margin-top: 3px; font-family: var(--font-mono, ui-monospace, monospace); opacity: 0.85; word-break: break-all; }
    .ractions { display: flex; gap: 6px; flex-shrink: 0; }
    .act {
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      background: var(--bg-base); color: var(--text-primary);
      padding: 5px 11px; border-radius: 6px; font-size: 0.78rem; cursor: pointer;
    }
    .act:hover { background: var(--bg-elevated); }
    .act.primary { background: var(--accent-primary, #06b6d4); border-color: transparent; color: #fff; }
    .act.danger:hover { background: color-mix(in srgb, #ef4444 20%, var(--bg-base)); border-color: #ef4444; }
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
  `]
})
export class StudioVersionsComponent {
  private readonly electron = inject(ElectronService);

  readonly bfpPath = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);

  readonly edit = output<string>();        // working-file path -> open editor (with project state)
  readonly open = output<string>();         // book-variant abs path -> open standalone in the editor
  readonly exportDoc = output<string>();    // version path -> export EPUB/PDF
  readonly exportAudio = output<void>();    // export the M4B
  readonly listen = output<void>();
  readonly fixChapters = output<void>();
  readonly skipped = output<void>();
  readonly continueJob = output<void>();    // resume the partial render (routes to the Processing wizard)
  readonly assemble = output<void>();       // assemble the cached sentences (routes to the Processing wizard)
  readonly changed = output<void>();        // after delete/edit -> tell Studio to refresh
  readonly compareActive = output<boolean>(); // Studio goes full-height while comparing

  readonly versions = signal<VersionRow[]>([]);
  readonly loading = signal(false);
  readonly cache = signal<SentenceCacheInfo | null>(null);
  readonly comparing = signal<{ a: string; b: string; labelA: string; labelB: string } | null>(null);

  // Book variants (editions/languages/formats)
  readonly variantList = signal<ProjectVariant[]>([]);
  readonly primaryId = signal<string | undefined>(undefined);
  readonly openId = signal<string | null>(null);
  readonly savingId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly vDragOver = signal(false);
  private vDragCounter = 0;
  private readonly pendingCover = signal<Record<string, string>>({});
  readonly descriptorDraft = signal<Record<string, string>>({});
  // A STABLE EpubMetadata reference per open variant. The metadata-editor resets
  // its form whenever this input's reference changes, so we build it once when the
  // editor opens (after the cover loads) and never rebuild it while the user types.
  private readonly editorMetaCache = signal<Record<string, EpubMetadata>>({});

  readonly variants = computed(() => this.variantList());

  readonly documents = computed(() => this.versions().filter(v => v.type !== 'analysis'));

  readonly audioRows = computed(() => {
    const it = this.item();
    if (!it) return [] as Array<{ key: string; label: string; desc: string; mono: boolean }>;
    const rows: Array<{ key: string; label: string; desc: string; mono: boolean }> = [];
    if (it.audiobookPath) rows.push({ key: 'mono', label: 'Audiobook', desc: 'M4B' + (it.vttPath ? ' + chapters' : ''), mono: true });
    const bi = it.bilingualOutputs || {};
    for (const k of Object.keys(bi)) {
      const o = bi[k];
      rows.push({ key: k, label: `Bilingual (${o.sourceLang}→${o.targetLang})`, desc: 'M4B', mono: false });
    }
    return rows;
  });

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
    const p = this.item()?.id || this.bfpPath();
    return (p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  private async loadVariants(): Promise<void> {
    const pid = this.projectId();
    if (!pid) { this.variantList.set([]); this.primaryId.set(undefined); return; }
    try {
      const res = await this.electron.variantList(pid);
      if (res.success && res.variants) {
        this.variantList.set(res.variants as ProjectVariant[]);
        this.primaryId.set(res.primaryVariantId);
      } else {
        this.variantList.set([]); this.primaryId.set(undefined);
      }
    } catch {
      this.variantList.set([]); this.primaryId.set(undefined);
    }
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
    let coverData: string | undefined;
    const cp = v.metadata?.coverPath;
    if (cp) {
      try {
        const res = await this.electron.mediaLoadImage(cp);
        if (res.success && res.data) coverData = res.data;
      } catch { /* leave cover empty */ }
    }
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
    this.busy.set(true);
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
        if (!res.success) errors.push(`${p.split(/[\\/]/).pop()}: ${res.error || 'failed'}`);
        else if (res.variantId) lastAddedId = res.variantId;
      }
    } finally {
      this.busy.set(false);
    }
    await this.loadVariants();
    this.changed.emit();
    if (errors.length) {
      await this.electron.showMessageDialog({
        title: 'Some versions were not added',
        message: errors.join('\n'), type: 'warning',
      });
    }
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

  deletable(v: VersionRow): boolean { return !['original', 'exported', 'analysis'].includes(v.type); }

  async load(): Promise<void> {
    const bfp = this.bfpPath();
    // Leave any in-progress compare when the project changes or files refresh
    if (this.comparing()) this.closeCompare();
    this.openId.set(null);
    if (!bfp) { this.versions.set([]); this.variantList.set([]); return; }
    this.loading.set(true);
    try {
      const res = await this.electron.editorGetVersions(bfp);
      this.versions.set(res.success && res.versions ? res.versions as VersionRow[] : []);
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
    const electron = (window as any).electron;
    if (!electron?.reassembly?.getBfpSession) return;
    try {
      const res = await electron.reassembly.getBfpSession(bfp);
      const d = res?.success ? res.data : null;
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
}
