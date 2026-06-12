import { Component, inject, input, output, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';
import { DiffViewComponent } from '../../../audiobook/components/diff-view/diff-view.component';
import { StudioItem } from '../../models/studio.types';

interface VersionRow {
  id: string; type: string; label: string; description: string;
  path: string; extension: string; language?: string;
  modifiedAt?: string; fileSize?: number; editable: boolean; icon: string;
}

/**
 * StudioVersionsComponent - the "Versions" surface of the four-tab book view.
 *
 * Replaces the exposed raw file tree (project-files) with a clean list of the
 * book's document versions (Original / Edited / Cleaned / Simplified /
 * Translated) plus its audio outputs. Every action lives on the row of the
 * thing it acts on: Edit, Compare (any two EPUB versions via the embedded
 * diff-view), Export, Delete; audio rows get Listen / Fix Chapters /
 * Skipped. No raw paths shown.
 */
@Component({
  selector: 'app-studio-versions',
  standalone: true,
  imports: [CommonModule, DiffViewComponent],
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
        <!-- Documents -->
        <div class="section-head">
          <span>Versions</span>
          @if (compareSource(); as src) {
            <span class="compare-hint">Comparing with <b>{{ src.label }}</b> — pick another EPUB, or
              <button class="link" (click)="compareSource.set(null)">cancel</button></span>
          }
        </div>

        @if (loading()) {
          <div class="muted">Loading versions…</div>
        } @else if (documents().length === 0) {
          <div class="muted">No document versions yet.</div>
        } @else {
          @for (v of documents(); track v.id) {
            <div class="row" [class.dim]="compareSource() && (!isEpub(v) || v.path === compareSource()?.path)">
              <span class="ricon">{{ v.icon || '\u{1F4C4}' }}</span>
              <div class="rinfo">
                <div class="rlabel">{{ v.label }} <span class="ext">.{{ v.extension }}</span></div>
                <div class="rdesc">{{ v.description }}{{ v.fileSize ? ' · ' + fmtSize(v.fileSize) : '' }}{{ v.modifiedAt ? ' · ' + fmtDate(v.modifiedAt) : '' }}</div>
              </div>
              <div class="ractions">
                @if (compareSource()) {
                  @if (isEpub(v) && v.path !== compareSource()?.path) {
                    <button class="act primary" (click)="pickCompareTarget(v)">Compare with this</button>
                  }
                } @else {
                  @if (v.editable) { <button class="act" (click)="edit.emit(v.path)">Edit</button> }
                  @if (isEpub(v) && epubCount() > 1) { <button class="act" (click)="compareSource.set(v)">Compare…</button> }
                  @if (hasSkippedReport(v)) { <button class="act" (click)="skipped.emit()">Skipped</button> }
                  <button class="act" (click)="exportDoc.emit(v.path)">Export…</button>
                  @if (deletable(v)) { <button class="act danger" (click)="remove(v)">Delete</button> }
                }
              </div>
            </div>
          }
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
    .compare-hint { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 0.78rem; }
    .link { background: none; border: none; color: var(--accent-primary); cursor: pointer; padding: 0; font-size: inherit; }
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
    app-diff-view { flex: 1; min-height: 0; display: block; }
  `]
})
export class StudioVersionsComponent {
  private readonly electron = inject(ElectronService);

  readonly bfpPath = input<string>('');
  readonly item = input<StudioItem | null>(null);
  readonly refreshTrigger = input<number>(0);

  readonly edit = output<string>();        // version path -> open editor
  readonly exportDoc = output<string>();    // version path -> export EPUB/PDF
  readonly exportAudio = output<void>();    // export the M4B
  readonly listen = output<void>();
  readonly fixChapters = output<void>();
  readonly skipped = output<void>();
  readonly changed = output<void>();        // after delete -> tell Studio to refresh
  readonly compareActive = output<boolean>(); // Studio goes full-height while comparing

  readonly versions = signal<VersionRow[]>([]);
  readonly loading = signal(false);
  readonly compareSource = signal<VersionRow | null>(null);
  readonly comparing = signal<{ a: string; b: string; labelA: string; labelB: string } | null>(null);

  readonly documents = computed(() => this.versions().filter(v => v.type !== 'analysis'));
  readonly epubCount = computed(() => this.documents().filter(v => this.isEpub(v)).length);

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
    effect(() => { this.bfpPath(); this.refreshTrigger(); void this.load(); });
  }

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
    this.compareSource.set(null);
    if (!bfp) { this.versions.set([]); return; }
    this.loading.set(true);
    try {
      const res = await this.electron.editorGetVersions(bfp);
      this.versions.set(res.success && res.versions ? res.versions as VersionRow[] : []);
    } finally {
      this.loading.set(false);
    }
  }

  pickCompareTarget(b: VersionRow): void {
    const a = this.compareSource();
    if (!a) return;
    this.comparing.set({ a: a.path, b: b.path, labelA: a.label, labelB: b.label });
    this.compareSource.set(null);
    this.compareActive.emit(true);
  }

  closeCompare(): void {
    this.comparing.set(null);
    this.compareActive.emit(false);
  }

  async remove(v: VersionRow): Promise<void> {
    const { confirmed } = await this.electron.showConfirmDialog({
      title: 'Delete version',
      message: `Delete "${v.label}"? The original archived copy is not affected.`,
      confirmLabel: 'Delete', cancelLabel: 'Cancel', type: 'warning',
    });
    if (!confirmed) return;
    const res = await this.electron.deleteFile(v.path);
    if (res.success) { await this.load(); this.changed.emit(); }
  }

  fmtSize(b: number): string { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'; }
  fmtDate(iso: string): string { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleDateString(); }
}
