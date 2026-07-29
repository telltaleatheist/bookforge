import {
  Component, ChangeDetectionStrategy, ChangeDetectorRef, OnInit,
  inject, input, output, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  ElectronService, EpubFlowBlock, EpubFlowSection,
} from '../../../../core/services/electron.service';

/** A block plus the section it belongs to, for flat rendering. */
interface FlowRow {
  block: EpubFlowBlock;
  sectionHref: string;
  /** Pre-sanitized markup — computed once, not per change-detection pass. */
  rendered: SafeHtml;
}

/**
 * EpubFlow — the EPUB-only editor.
 *
 * A PDF has to be reconstructed from positioned glyphs, so it gets the picker:
 * page images, bounding boxes, regions, a category learner. An EPUB already
 * states its own structure, and reflowing it through a page layout throws that
 * away — measured across the library, EPUBs with ~1,300 authored paragraphs came
 * back out of the picker as a couple dozen blobs full of hard line breaks.
 *
 * So an EPUB is shown as what it actually is: its own block elements in reading
 * order. The row the user sees IS the element in the file, which is what lets
 * export copy the book verbatim and remove exactly the excluded elements —
 * `<sup>` footnote markers, headings, emphasis and lists all survive, because
 * nothing ever re-serializes the prose it did not touch.
 */
@Component({
  selector: 'app-epub-flow',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flow">
      <header class="toolbar">
        <div class="counts">
          <strong>{{ keptCount() }}</strong> kept
          @if (excludedCount() > 0) {
            <span class="excluded-count">· {{ excludedCount() }} excluded</span>
          }
          <span class="dim">of {{ totalBlocks() }} · {{ keptWords() | number }} words</span>
        </div>

        <input
          class="search"
          type="search"
          placeholder="Filter blocks…"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
        />

        <label class="toggle">
          <input type="checkbox" [ngModel]="hideExcluded()" (ngModelChange)="hideExcluded.set($event)" />
          Hide excluded
        </label>

        <button class="btn" [disabled]="excludedCount() === 0" (click)="restoreAll()">Restore all</button>
        <button class="btn primary" [disabled]="loading()" (click)="emitSelection()">Use this selection</button>
      </header>

      @if (warnings().length > 0) {
        <div class="warnings">
          <strong>{{ warnings().length }} section(s) could not be read</strong>
          <ul>
            @for (w of warnings(); track w) { <li>{{ w }}</li> }
          </ul>
        </div>
      }

      @if (loading()) {
        <div class="state">Reading the book…</div>
      } @else if (error()) {
        <div class="state error">{{ error() }}</div>
      } @else {
        <div class="body">
          <nav class="spine">
            @for (s of sections(); track s.href) {
              <button
                class="spine-item"
                [class.all-excluded]="sectionExcluded(s) === s.blocks.length && s.blocks.length > 0"
                (click)="scrollToSection(s.href)"
              >
                <span class="spine-title">{{ s.title }}</span>
                <span class="spine-count">
                  {{ s.blocks.length - sectionExcluded(s) }}/{{ s.blocks.length }}
                </span>
              </button>
            }
          </nav>

          <main class="rows">
            @for (s of visibleSections(); track s.href) {
              <div class="section-head" [id]="anchorId(s.href)">
                <h3>{{ s.title }}</h3>
                <div class="section-actions">
                  <button class="link" (click)="excludeSection(s)">Exclude section</button>
                  <button class="link" (click)="restoreSection(s)">Restore</button>
                </div>
              </div>

              @for (row of s.rows; track row.block.id) {
                <div
                  class="row"
                  [class.excluded]="isExcluded(row.block.id)"
                  [class.heading]="isHeading(row.block.tag)"
                  (click)="toggle(row.block.id)"
                >
                  <span class="tag" [attr.data-tag]="row.block.tag">{{ row.block.tag }}</span>
                  <div class="content">
                    @if (row.block.isImage) {
                      <em class="image-note">[image]{{ row.block.text ? ' ' + row.block.text : '' }}</em>
                    } @else {
                      <span [innerHTML]="row.rendered"></span>
                    }
                  </div>
                  <span class="state-dot" [title]="isExcluded(row.block.id) ? 'Excluded' : 'Kept'"></span>
                </div>
              }
            } @empty {
              <div class="state">Nothing matches “{{ query() }}”.</div>
            }
          </main>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Without an explicit :host display the host is inline and the panel cannot scroll. */
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .flow { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); color: var(--text-primary); }

    .toolbar {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; background: var(--bg-toolbar);
      border-bottom: 1px solid var(--border-default); flex: 0 0 auto;
    }
    .counts { font-size: 13px; }
    .counts .dim { color: var(--text-tertiary); margin-left: 6px; }
    .excluded-count { color: var(--warning); margin-left: 4px; }
    .search {
      flex: 1 1 auto; max-width: 320px; padding: 5px 9px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-input); border-radius: 5px; font-size: 13px;
    }
    .toggle { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-tertiary); white-space: nowrap; }
    .btn {
      padding: 5px 11px; font-size: 13px; border-radius: 5px; cursor: pointer;
      background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-default);
    }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }

    .warnings {
      flex: 0 0 auto; padding: 8px 14px; font-size: 12px;
      background: var(--bg-sunken); border-bottom: 1px solid var(--border-default); color: var(--warning);
    }
    .warnings ul { margin: 4px 0 0; padding-left: 18px; }

    .state { padding: 32px; text-align: center; color: var(--text-tertiary); }
    .state.error { color: var(--warning); }

    .body { display: flex; flex: 1 1 auto; min-height: 0; }

    .spine {
      flex: 0 0 220px; overflow-y: auto; padding: 8px;
      background: var(--bg-sidebar); border-right: 1px solid var(--border-default);
    }
    .spine-item {
      display: flex; justify-content: space-between; gap: 8px; width: 100%;
      padding: 6px 8px; margin-bottom: 2px; text-align: left; cursor: pointer;
      background: transparent; border: 0; border-radius: 4px;
      color: var(--text-primary); font-size: 12px;
    }
    .spine-item:hover { background: var(--bg-elevated); }
    .spine-item.all-excluded .spine-title { text-decoration: line-through; opacity: .55; }
    .spine-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spine-count { color: var(--text-tertiary); font-variant-numeric: tabular-nums; flex: 0 0 auto; }

    .rows { flex: 1 1 auto; overflow-y: auto; padding: 0 0 40vh; }

    .section-head {
      position: sticky; top: 0; z-index: 1;
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      padding: 10px 16px; background: var(--bg-surface);
      border-bottom: 1px solid var(--border-default);
    }
    .section-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
    .section-actions { display: flex; gap: 10px; }
    .link { background: none; border: 0; padding: 0; cursor: pointer; font-size: 12px; color: var(--accent); }

    .row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 7px 16px; cursor: pointer;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row:hover { background: var(--bg-elevated); }
    .row.excluded .content { opacity: .4; text-decoration: line-through; }
    .row.heading .content { font-weight: 600; }

    .tag {
      flex: 0 0 auto; min-width: 34px; padding: 1px 5px; border-radius: 3px;
      font-size: 10px; text-transform: uppercase; letter-spacing: .04em; text-align: center;
      background: var(--bg-sunken); color: var(--text-tertiary); border: 1px solid var(--border-subtle);
    }
    .tag[data-tag^="h"] { color: var(--accent); border-color: var(--border-accent); }

    .content { flex: 1 1 auto; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
    .content sup { font-size: .7em; vertical-align: super; color: var(--accent); }
    .image-note { color: var(--text-tertiary); }

    .state-dot {
      flex: 0 0 auto; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%;
      background: var(--accent);
    }
    .row.excluded .state-dot { background: var(--warning); }
  `],
})
export class EpubFlowComponent implements OnInit {
  private electron = inject(ElectronService);
  private sanitizer = inject(DomSanitizer);
  private cdr = inject(ChangeDetectorRef);

  /** Path to the EPUB to read — the pristine archived original. */
  epubPath = input.required<string>();
  /** Block ids excluded in a previous session, restored on open. */
  initialExcluded = input<string[]>([]);

  /** Emitted when the user accepts the selection: the ids to REMOVE on export. */
  selectionAccepted = output<string[]>();

  loading = signal(true);
  error = signal<string | null>(null);
  warnings = signal<string[]>([]);
  sections = signal<EpubFlowSection[]>([]);
  excluded = signal<ReadonlySet<string>>(new Set());
  query = signal('');
  hideExcluded = signal(false);

  private renderedById = new Map<string, SafeHtml>();

  totalBlocks = computed(() => this.sections().reduce((n, s) => n + s.blocks.length, 0));
  excludedCount = computed(() => this.excluded().size);
  keptCount = computed(() => this.totalBlocks() - this.excludedCount());
  keptWords = computed(() => {
    const gone = this.excluded();
    let n = 0;
    for (const s of this.sections()) {
      for (const b of s.blocks) if (!gone.has(b.id)) n += b.wordCount;
    }
    return n;
  });

  /** Sections with their renderable rows, after the filter toggles. */
  visibleSections = computed<Array<EpubFlowSection & { rows: FlowRow[] }>>(() => {
    const q = this.query().trim().toLowerCase();
    const gone = this.excluded();
    const hide = this.hideExcluded();
    const out: Array<EpubFlowSection & { rows: FlowRow[] }> = [];

    for (const s of this.sections()) {
      const rows: FlowRow[] = [];
      for (const b of s.blocks) {
        if (hide && gone.has(b.id)) continue;
        if (q && !b.text.toLowerCase().includes(q)) continue;
        rows.push({
          block: b,
          sectionHref: s.href,
          rendered: this.renderedById.get(b.id) ?? this.sanitizer.bypassSecurityTrustHtml(''),
        });
      }
      if (rows.length > 0) out.push({ ...s, rows });
    }
    return out;
  });

  async ngOnInit(): Promise<void> {
    this.excluded.set(new Set(this.initialExcluded()));

    const result = await this.electron.extractEpubDocumentFlow(this.epubPath());
    if (!result.success || !result.sections) {
      this.error.set(result.error || 'Could not read this EPUB.');
      this.loading.set(false);
      this.cdr.markForCheck();
      return;
    }

    // Sanitize once at load. Doing it inside the template would re-run for every
    // row on every change-detection pass, and a book is thousands of rows.
    for (const s of result.sections) {
      for (const b of s.blocks) {
        this.renderedById.set(b.id, this.sanitizer.bypassSecurityTrustHtml(this.stripImages(b.html)));
      }
    }

    this.sections.set(result.sections);
    this.warnings.set(result.warnings ?? []);
    this.loading.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Images cannot load in the row — their `src` is a path inside the EPUB zip, not
   * anything the renderer can fetch. Replace them with their alt text so the row
   * still says what is there, instead of showing a broken-image glyph.
   */
  private stripImages(html: string): string {
    return html.replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? '';
      return alt ? `<em>[image: ${alt}]</em>` : '<em>[image]</em>';
    });
  }

  isExcluded(id: string): boolean { return this.excluded().has(id); }
  isHeading(tag: string): boolean { return /^h[1-6]$/.test(tag); }
  anchorId(href: string): string { return 'sec-' + href.replace(/[^A-Za-z0-9]/g, '-'); }

  sectionExcluded(s: EpubFlowSection): number {
    const gone = this.excluded();
    let n = 0;
    for (const b of s.blocks) if (gone.has(b.id)) n++;
    return n;
  }

  toggle(id: string): void {
    const next = new Set(this.excluded());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.excluded.set(next);
  }

  excludeSection(s: EpubFlowSection): void {
    const next = new Set(this.excluded());
    for (const b of s.blocks) next.add(b.id);
    this.excluded.set(next);
  }

  restoreSection(s: EpubFlowSection): void {
    const next = new Set(this.excluded());
    for (const b of s.blocks) next.delete(b.id);
    this.excluded.set(next);
  }

  restoreAll(): void { this.excluded.set(new Set()); }

  scrollToSection(href: string): void {
    document.getElementById(this.anchorId(href))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  emitSelection(): void {
    this.selectionAccepted.emit([...this.excluded()]);
  }
}
