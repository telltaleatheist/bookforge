import {
  Component, ChangeDetectionStrategy, ChangeDetectorRef, OnInit,
  inject, input, output, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  ElectronService, EpubFlowBlock, EpubFlowSection, EpubBlockKind, EpubSectionRole,
  EPUB_FRONT_BACK_MATTER,
} from '../../../../core/services/electron.service';

/** A block plus its pre-sanitized markup, computed once at load. */
interface FlowRow {
  block: EpubFlowBlock;
  rendered: SafeHtml;
}

/** A section ready to render, with its live counts. */
interface FlowGroup extends EpubFlowSection {
  rows: FlowRow[];
  excludedCount: number;
  /** Every block in this section is excluded — the section is "deleted". */
  allExcluded: boolean;
}

const ROLE_LABELS: Record<EpubSectionRole, string> = {
  'cover': 'Cover', 'title-page': 'Title page', 'copyright': 'Copyright',
  'dedication': 'Dedication', 'epigraph': 'Epigraph', 'toc': 'Contents',
  'foreword': 'Foreword', 'preface': 'Preface', 'acknowledgments': 'Acknowledgments',
  'body': 'Body', 'notes': 'Notes', 'bibliography': 'Bibliography',
  'index': 'Index', 'glossary': 'Glossary', 'appendix': 'Appendix',
  'about-author': 'About the author', 'advertisement': 'Promotional',
};

/**
 * EpubFlow — the EPUB-only editor.
 *
 * A PDF has to be reconstructed from positioned glyphs, so it gets the picker:
 * page images, bounding boxes, regions, a category learner. An EPUB already
 * states its own structure, so it is shown as what it is — its own block elements
 * in reading order, grouped by the spine document they live in.
 *
 * The row the user sees IS the element in the file, which is what lets export copy
 * the book verbatim and remove exactly the excluded elements: `<sup>` footnote
 * markers, headings, lists and emphasis all survive, because nothing re-serializes
 * the prose it did not touch.
 *
 * A spine document is the EPUB's answer to a "page" — the copyright page, the
 * title page, the table of contents are each one file — so each group can be
 * dropped whole with a single click, and its detected role says which is which.
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
            <span class="excluded-count">· {{ excludedCount() }} removed</span>
          }
          <span class="dim">of {{ totalBlocks() }} · {{ keptWords() | number }} words</span>
        </div>

        <input
          class="search" type="search" placeholder="Filter…"
          [ngModel]="query()" (ngModelChange)="query.set($event)"
        />

        <select class="kind-filter" [ngModel]="kindFilter()" (ngModelChange)="kindFilter.set($event)">
          <option value="">All kinds</option>
          @for (k of kindsPresent(); track k) { <option [value]="k">{{ k }}</option> }
        </select>

        <label class="toggle">
          <input type="checkbox" [ngModel]="hideExcluded()" (ngModelChange)="hideExcluded.set($event)" />
          Hide removed
        </label>

        @if (suggestedSections().length > 0) {
          <button
            class="btn suggest"
            [title]="suggestTitle()"
            (click)="excludeSuggested()"
          >Remove {{ suggestedSections().length }} front/back matter</button>
        }
        <button class="btn" [disabled]="excludedCount() === 0" (click)="restoreAll()">Restore all</button>
        <button class="btn primary" [disabled]="loading()" (click)="emitSelection()">Save &amp; export</button>
      </header>

      @if (warnings().length > 0) {
        <div class="warnings">
          <strong>{{ warnings().length }} problem(s) reading this book</strong>
          <ul>@for (w of warnings(); track w) { <li>{{ w }}</li> }</ul>
        </div>
      }

      @if (loading()) {
        <div class="state">Reading the book…</div>
      } @else if (error()) {
        <div class="state error">{{ error() }}</div>
      } @else {
        <div class="body">
          <nav class="spine">
            @for (g of groups(); track g.href) {
              <button
                class="spine-item"
                [class.all-excluded]="g.allExcluded"
                (click)="scrollToSection(g.href)"
                [title]="g.roleEvidence || ''"
              >
                <span class="spine-main">
                  <span class="spine-title">{{ g.title }}</span>
                  @if (g.role) { <span class="role-badge" [attr.data-role]="g.role">{{ roleLabel(g.role) }}</span> }
                </span>
                <span class="spine-count">{{ g.blocks.length - g.excludedCount }}/{{ g.blocks.length }}</span>
              </button>
            }
          </nav>

          <main class="rows">
            @for (g of visibleGroups(); track g.href) {
              <div class="section-head" [id]="anchorId(g.href)" [class.all-excluded]="g.allExcluded">
                <div class="section-id">
                  <h3>{{ g.title }}</h3>
                  @if (g.role) {
                    <span class="role-badge" [attr.data-role]="g.role" [title]="g.roleEvidence || ''">
                      {{ roleLabel(g.role) }}
                    </span>
                  }
                  <span class="dim">{{ g.blocks.length }} blocks</span>
                </div>
                <button
                  class="section-toggle"
                  [class.restore]="g.allExcluded"
                  (click)="toggleSection(g)"
                >{{ g.allExcluded ? 'Restore this section' : 'Remove this section' }}</button>
              </div>

              @for (row of g.rows; track row.block.id) {
                <div
                  class="row"
                  [class.excluded]="isExcluded(row.block.id)"
                  [class.is-heading]="row.block.kind === 'heading' || row.block.kind === 'subheading'"
                  (click)="toggle(row.block.id)"
                >
                  <span class="kind" [attr.data-kind]="row.block.kind">{{ row.block.kind }}</span>
                  <div class="content">
                    @if (row.block.isImage) {
                      <em class="image-note">[image]{{ row.block.text ? ' ' + row.block.text : '' }}</em>
                    } @else {
                      <span [innerHTML]="row.rendered"></span>
                    }
                  </div>
                  <span class="state-dot" [title]="isExcluded(row.block.id) ? 'Removed' : 'Kept'"></span>
                </div>
              }
            } @empty {
              <div class="state">Nothing matches the current filter.</div>
            }
          </main>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Without an explicit :host display the host is inline and cannot scroll. */
    :host { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .flow { display: flex; flex-direction: column; height: 100%; min-height: 0;
            background: var(--bg-base); color: var(--text-primary); }

    .toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
               background: var(--bg-toolbar); border-bottom: 1px solid var(--border-default); flex: 0 0 auto; }
    .counts { font-size: 13px; white-space: nowrap; }
    .counts .dim, .dim { color: var(--text-tertiary); }
    .counts .dim { margin-left: 6px; }
    .excluded-count { color: var(--warning); margin-left: 4px; }
    .search { flex: 1 1 auto; min-width: 100px; max-width: 260px; padding: 5px 9px;
              background: var(--bg-input); color: var(--text-primary);
              border: 1px solid var(--border-input); border-radius: 5px; font-size: 13px; }
    .kind-filter { padding: 5px 6px; background: var(--bg-input); color: var(--text-primary);
                   border: 1px solid var(--border-input); border-radius: 5px; font-size: 12px; }
    .toggle { display: flex; align-items: center; gap: 5px; font-size: 12px;
              color: var(--text-tertiary); white-space: nowrap; }
    .btn { padding: 5px 11px; font-size: 13px; border-radius: 5px; cursor: pointer; white-space: nowrap;
           background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-default); }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn.suggest { border-color: var(--border-accent); color: var(--accent); }

    .warnings { flex: 0 0 auto; padding: 8px 14px; font-size: 12px; background: var(--bg-sunken);
                border-bottom: 1px solid var(--border-default); color: var(--warning); }
    .warnings ul { margin: 4px 0 0; padding-left: 18px; }

    .state { padding: 32px; text-align: center; color: var(--text-tertiary); }
    .state.error { color: var(--warning); }

    .body { display: flex; flex: 1 1 auto; min-height: 0; }

    .spine { flex: 0 0 250px; overflow-y: auto; padding: 8px;
             background: var(--bg-sidebar); border-right: 1px solid var(--border-default); }
    .spine-item { display: flex; justify-content: space-between; align-items: center; gap: 8px;
                  width: 100%; padding: 6px 8px; margin-bottom: 2px; text-align: left; cursor: pointer;
                  background: transparent; border: 0; border-radius: 4px;
                  color: var(--text-primary); font-size: 12px; }
    .spine-item:hover { background: var(--bg-elevated); }
    .spine-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .spine-item.all-excluded .spine-title { text-decoration: line-through; opacity: .5; }
    .spine-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spine-count { color: var(--text-tertiary); font-variant-numeric: tabular-nums; flex: 0 0 auto; }

    .rows { flex: 1 1 auto; overflow-y: auto; padding: 0 0 40vh; }

    .section-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center;
                    justify-content: space-between; gap: 12px; padding: 10px 16px;
                    background: var(--bg-surface); border-bottom: 1px solid var(--border-default); }
    .section-head.all-excluded { opacity: .6; }
    .section-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .section-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
    .section-toggle { padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 4px;
                      background: transparent; color: var(--warning);
                      border: 1px solid var(--border-default); white-space: nowrap; }
    .section-toggle:hover { background: var(--bg-elevated); }
    .section-toggle.restore { color: var(--accent); }

    .role-badge { flex: 0 0 auto; padding: 1px 6px; border-radius: 3px; font-size: 10px;
                  text-transform: uppercase; letter-spacing: .04em;
                  background: var(--bg-sunken); color: var(--text-tertiary);
                  border: 1px solid var(--border-subtle); }
    .role-badge[data-role="copyright"], .role-badge[data-role="cover"],
    .role-badge[data-role="title-page"], .role-badge[data-role="toc"],
    .role-badge[data-role="index"], .role-badge[data-role="advertisement"],
    .role-badge[data-role="bibliography"], .role-badge[data-role="about-author"] {
      color: var(--warning); border-color: var(--warning); }
    .role-badge[data-role="body"] { color: var(--accent); border-color: var(--border-accent); }

    .row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 16px; cursor: pointer;
           border-bottom: 1px solid var(--border-subtle); }
    .row:hover { background: var(--bg-elevated); }
    .row.excluded .content { opacity: .4; text-decoration: line-through; }
    .row.is-heading .content { font-weight: 600; }

    .kind { flex: 0 0 auto; min-width: 62px; padding: 1px 5px; border-radius: 3px; font-size: 10px;
            text-transform: uppercase; letter-spacing: .04em; text-align: center;
            background: var(--bg-sunken); color: var(--text-tertiary);
            border: 1px solid var(--border-subtle); }
    .kind[data-kind="heading"], .kind[data-kind="subheading"] {
      color: var(--accent); border-color: var(--border-accent); }
    .kind[data-kind="legal"], .kind[data-kind="toc-entry"], .kind[data-kind="note"] {
      color: var(--warning); border-color: var(--warning); }

    .content { flex: 1 1 auto; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
    .content sup { font-size: .7em; vertical-align: super; color: var(--accent); }
    .image-note { color: var(--text-tertiary); }

    .state-dot { flex: 0 0 auto; width: 8px; height: 8px; margin-top: 6px;
                 border-radius: 50%; background: var(--accent); }
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

  /** Emitted when the user saves: the ids to REMOVE on export. */
  selectionAccepted = output<string[]>();

  loading = signal(true);
  error = signal<string | null>(null);
  warnings = signal<string[]>([]);
  sections = signal<EpubFlowSection[]>([]);
  excluded = signal<ReadonlySet<string>>(new Set());
  query = signal('');
  kindFilter = signal<'' | EpubBlockKind>('');
  hideExcluded = signal(false);

  private renderedById = new Map<string, SafeHtml>();

  totalBlocks = computed(() => this.sections().reduce((n, s) => n + s.blocks.length, 0));
  excludedCount = computed(() => this.excluded().size);
  keptCount = computed(() => this.totalBlocks() - this.excludedCount());

  keptWords = computed(() => {
    const gone = this.excluded();
    let n = 0;
    for (const s of this.sections()) for (const b of s.blocks) if (!gone.has(b.id)) n += b.wordCount;
    return n;
  });

  kindsPresent = computed(() => {
    const set = new Set<EpubBlockKind>();
    for (const s of this.sections()) for (const b of s.blocks) set.add(b.kind);
    return [...set].sort();
  });

  /** Every section with live counts — drives the spine rail. */
  groups = computed<FlowGroup[]>(() => {
    const gone = this.excluded();
    return this.sections().map((s) => {
      let excludedCount = 0;
      for (const b of s.blocks) if (gone.has(b.id)) excludedCount++;
      return {
        ...s,
        rows: [],
        excludedCount,
        allExcluded: s.blocks.length > 0 && excludedCount === s.blocks.length,
      };
    });
  });

  /** Sections that still have rows after the filters, with those rows attached. */
  visibleGroups = computed<FlowGroup[]>(() => {
    const q = this.query().trim().toLowerCase();
    const kind = this.kindFilter();
    const hide = this.hideExcluded();
    const gone = this.excluded();
    const out: FlowGroup[] = [];

    for (const g of this.groups()) {
      const rows: FlowRow[] = [];
      for (const b of g.blocks) {
        if (hide && gone.has(b.id)) continue;
        if (kind && b.kind !== kind) continue;
        if (q && !b.text.toLowerCase().includes(q)) continue;
        rows.push({ block: b, rendered: this.renderedById.get(b.id)! });
      }
      if (rows.length > 0) out.push({ ...g, rows });
    }
    return out;
  });

  /**
   * Sections whose detected role is front or back matter and that are still fully
   * kept. Offered as a one-click action — never applied automatically, because a
   * detected role is evidence, not permission.
   */
  suggestedSections = computed(() =>
    this.groups().filter(
      (g) => g.role !== null
        && EPUB_FRONT_BACK_MATTER.includes(g.role)
        && g.blocks.length > 0
        && !g.allExcluded,
    ),
  );

  suggestTitle = computed(() =>
    'Removes: ' + this.suggestedSections().map((g) => `${g.title} (${this.roleLabel(g.role!)})`).join(', '),
  );

  async ngOnInit(): Promise<void> {
    this.excluded.set(new Set(this.initialExcluded()));

    const result = await this.electron.extractEpubDocumentFlow(this.epubPath());
    if (!result.success || !result.sections) {
      this.error.set(result.error || 'Could not read this EPUB.');
      this.loading.set(false);
      this.cdr.markForCheck();
      return;
    }

    // Sanitize once at load. Doing it in the template would re-run for every row on
    // every change-detection pass, and a book is thousands of rows.
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
   * Images cannot load in a row — their `src` points inside the EPUB zip, which the
   * renderer cannot fetch. Show the alt text instead of a broken-image glyph.
   */
  private stripImages(html: string): string {
    return html.replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? '';
      return alt ? `<em>[image: ${alt}]</em>` : '<em>[image]</em>';
    });
  }

  roleLabel(role: EpubSectionRole): string { return ROLE_LABELS[role]; }
  isExcluded(id: string): boolean { return this.excluded().has(id); }
  anchorId(href: string): string { return 'sec-' + href.replace(/[^A-Za-z0-9]/g, '-'); }

  toggle(id: string): void {
    const next = new Set(this.excluded());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.excluded.set(next);
  }

  /** Drop or restore a whole spine document — the EPUB's version of a page. */
  toggleSection(g: FlowGroup): void {
    const next = new Set(this.excluded());
    if (g.allExcluded) {
      for (const b of g.blocks) next.delete(b.id);
    } else {
      for (const b of g.blocks) next.add(b.id);
    }
    this.excluded.set(next);
  }

  excludeSuggested(): void {
    const next = new Set(this.excluded());
    for (const g of this.suggestedSections()) for (const b of g.blocks) next.add(b.id);
    this.excluded.set(next);
  }

  restoreAll(): void { this.excluded.set(new Set()); }

  scrollToSection(href: string): void {
    document.getElementById(this.anchorId(href))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  emitSelection(): void { this.selectionAccepted.emit([...this.excluded()]); }
}
