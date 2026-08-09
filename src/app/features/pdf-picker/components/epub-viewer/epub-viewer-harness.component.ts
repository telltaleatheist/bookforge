/**
 * A bench for the EPUB viewer, and nothing else.
 *
 * `/#/epub-viewer-harness?book=<path>` opens a real EPUB through quire and
 * drives {@link EpubViewerComponent} with the picker's own gesture vocabulary,
 * so the component can be built and proved against a real book before Phase C
 * hands it the picker's actual state. It follows the same pattern as the app's
 * other isolated-window routes (`/editor`, `/listen`, `/alignment`): a plain
 * route this app can be pointed at, holding its own state, talking to one
 * narrow IPC pair.
 *
 * It owns the halves of the picker the viewer deliberately does NOT own:
 * selection, deletion and the zoom/layout controls all live up here, because
 * they live in `pdf-picker.component.ts` for the raster viewer too. The viewer
 * emits gestures; the thing above it decides what they mean.
 *
 * Deliberately not wired into the app's navigation. It is a bench.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import type { LaidOutBlock, LaidOutBook } from '@shared/document/laid-out-book';
import { BLOCK_CATEGORIES, toCategory } from '@shared/ocr/block-categories';
import type { Category } from '../../services/pdf.service';
import { EpubViewerComponent, type EpubViewerSource } from './epub-viewer.component';

interface Opening {
  handle: string;
  book: LaidOutBook;
  source: EpubViewerSource;
  stats: Record<string, number | string>;
}

@Component({
  selector: 'app-epub-viewer-harness',
  standalone: true,
  imports: [CommonModule, EpubViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bench">
      <header class="bar">
        <input
          class="path"
          type="text"
          placeholder="Path to an .epub"
          [value]="bookPath()"
          (change)="bookPath.set($any($event.target).value)"
        />
        <button type="button" (click)="openBook()" [disabled]="busy()">
          {{ busy() ? 'Opening…' : 'Open' }}
        </button>

        @if (opening(); as open) {
          <span class="stat">{{ open.stats['pages'] }} pages · {{ open.stats['documents'] }} docs ·
            {{ open.stats['blocks'] }} blocks · stamp {{ open.stats['stampMs'] }} ms ·
            layout {{ open.stats['layoutMs'] }} ms · open {{ open.stats['totalMs'] }} ms ·
            {{ open.stats['strategy'] }}</span>

          <span class="spacer"></span>

          <label>Zoom
            <button type="button" (click)="onZoomChange(-10)">−</button>
            <span class="zoom">{{ zoom() }}%</span>
            <button type="button" (click)="onZoomChange(10)">+</button>
          </label>
          <label>Layout
            <select [value]="viewerLayout()" (change)="viewerLayout.set($any($event.target).value)">
              <option value="vertical">vertical</option>
              <option value="grid">grid</option>
            </select>
          </label>
          <label>Hide category
            <select [value]="hiddenCategory()" (change)="hiddenCategory.set($any($event.target).value)">
              <option value="">— none —</option>
              @for (category of categoryIds(); track category) {
                <option [value]="category">{{ category }}</option>
              }
            </select>
          </label>
          <button type="button" (click)="strikeSelection()" [disabled]="selected().length === 0">
            Strike {{ selected().length }} selected
          </button>
          <button type="button" (click)="clearStrikes()" [disabled]="struck().size === 0">
            Unstrike all ({{ struck().size }})
          </button>
          <button type="button" (click)="clearSelection()" [disabled]="selected().length === 0">
            Clear selection
          </button>
        }
      </header>

      @if (failure(); as why) {
        <div class="failure">{{ why }}</div>
      }

      @if (opening(); as open) {
        <app-epub-viewer
          [book]="open.book"
          [source]="open.source"
          [categories]="categories()"
          [hiddenCategoryIds]="hiddenCategoryIds()"
          [selectedBlockIds]="selected()"
          [deletedBlockIds]="struck()"
          [deletedPages]="struckPages()"
          [selectedPages]="selectedPageSet()"
          [zoom]="zoom()"
          [layout]="viewerLayout()"
          (blockClick)="onBlockClick($event)"
          (blockDoubleClick)="log('double-click ' + $event.block.id)"
          (blockHover)="hovered.set($event)"
          (selectLikeThis)="selectLikeThis($event)"
          (deleteLikeThis)="deleteLikeThis($event)"
          (deleteBlock)="strikeIds([$event])"
          (marqueeSelect)="onMarquee($event)"
          (pageDeleteToggle)="togglePage($event)"
          (pageSelect)="onPageSelect($event)"
          (selectAllOnPage)="selectAllOnPage($event)"
          (deselectAllOnPage)="deselectAllOnPage($event)"
          (zoomChange)="onZoomChange($event)"
        />
      } @else if (!failure()) {
        <div class="failure">Give it a book.</div>
      }

      <footer class="bar">
        <span class="stat">
          @if (hovered(); as block) {
            {{ block.id }} · {{ block.category_id }} · page {{ block.page + 1 }} ·
            “{{ block.text.slice(0, 90) }}”
          } @else { — }
        </span>
        <span class="spacer"></span>
        <span class="stat">{{ lastEvent() }}</span>
      </footer>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host { display: flex; flex-direction: column; height: 100vh; background: var(--bg-sunken); }

    .bench { display: flex; flex-direction: column; height: 100%; min-height: 0; }

    .bar {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      flex-wrap: wrap;
    }

    footer.bar { border-bottom: 0; border-top: 1px solid var(--border-subtle); }

    .spacer { flex: 1; }
    .stat { color: var(--text-tertiary); }
    .zoom { min-width: 48px; display: inline-block; text-align: center; }

    .path {
      flex: 0 1 460px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-default);
      border-radius: $radius-sm;
      color: var(--text-primary);
      padding: 4px 8px;
      font-size: var(--ui-font-xs);
    }

    button, select {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      border-radius: $radius-sm;
      padding: 3px 8px;
      font-size: var(--ui-font-xs);
      cursor: pointer;

      &:disabled { color: var(--text-tertiary); cursor: not-allowed; }
    }

    label { display: inline-flex; align-items: center; gap: 4px; }

    .failure {
      margin: var(--ui-spacing-lg);
      padding: var(--ui-spacing-md);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      background: var(--bg-elevated);
      color: var(--text-primary);
      white-space: pre-wrap;
      font-size: var(--ui-font-sm);
    }

    app-epub-viewer { flex: 1; min-height: 0; }
  `],
})
export class EpubViewerHarnessComponent {
  private readonly route = inject(ActivatedRoute);

  protected readonly bookPath = signal(this.route.snapshot.queryParamMap.get('book') ?? '');
  protected readonly opening = signal<Opening | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly zoom = signal(100);
  protected readonly viewerLayout = signal<'vertical' | 'grid'>('vertical');
  protected readonly selected = signal<string[]>([]);
  protected readonly struck = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly struckPages = signal<ReadonlySet<number>>(new Set<number>());
  protected readonly selectedPageSet = signal<ReadonlySet<number>>(new Set<number>());
  protected readonly hovered = signal<LaidOutBlock | null>(null);
  protected readonly hiddenCategory = signal('');
  protected readonly lastEvent = signal('—');

  /** The one palette, as the raster viewer receives it. */
  protected readonly categories = computed<Record<string, Category>>(() => {
    const out: Record<string, Category> = {};
    for (const def of BLOCK_CATEGORIES) out[def.id] = toCategory(def);
    return out;
  });

  protected readonly categoryIds = computed(() => {
    const book = this.opening()?.book;
    if (!book) return [] as string[];
    return [...new Set(book.blocks.map((b) => b.category_id))].sort();
  });

  protected readonly hiddenCategoryIds = computed<ReadonlySet<string>>(() => {
    const one = this.hiddenCategory();
    return one === '' ? new Set<string>() : new Set([one]);
  });

  protected log(what: string): void { this.lastEvent.set(what); }

  async openBook(): Promise<void> {
    const path = this.bookPath().trim();
    if (path === '') { this.failure.set('No book path given.'); return; }
    this.busy.set(true);
    this.failure.set(null);
    try {
      const previous = this.opening();
      this.opening.set(null);
      if (previous) await this.bridge().closeBook(previous.handle);
      const result = await this.bridge().openBook(path);
      if (!result.success || !result.data) {
        this.failure.set(result.error ?? 'The main process refused the book without saying why.');
        return;
      }
      this.opening.set(result.data as Opening);
      this.selected.set([]);
      this.struck.set(new Set());
      this.struckPages.set(new Set());
      this.log(`opened ${path}`);
    } catch (err) {
      this.failure.set(String((err as Error).message ?? err));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The harness reaches the bridge directly rather than through
   * `ElectronService`, because it is a bench for one component and adding a
   * method to the app's service for it would put a development-only channel in
   * the app's own API. Phase C wires the real path through the service.
   */
  private bridge(): {
    openBook: (p: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    closeBook: (h: string) => Promise<{ success: boolean; error?: string }>;
  } {
    const api = (window as unknown as { electron?: { quire?: unknown } }).electron?.quire;
    if (!api) {
      throw new Error(
        'window.electron.quire is not there, so this page is not running inside BookForge — '
        + 'the harness opens books through the main process and cannot do it from a browser.',
      );
    }
    return api as ReturnType<EpubViewerHarnessComponent['bridge']>;
  }

  // ── the picker's half of the gestures ─────────────────────────────────────

  protected onBlockClick(event: {
    block: LaidOutBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean;
  }): void {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const current = this.selected();
    if (!additive) { this.selected.set([event.block.id]); }
    else if (current.includes(event.block.id)) {
      this.selected.set(current.filter((id) => id !== event.block.id));
    } else {
      this.selected.set([...current, event.block.id]);
    }
    this.log(`click ${event.block.id} (${event.block.category_id})`);
  }

  protected onMarquee(event: { blockIds: string[]; additive: boolean }): void {
    this.selected.set(event.additive
      ? [...new Set([...this.selected(), ...event.blockIds])]
      : event.blockIds);
    this.log(`marquee selected ${event.blockIds.length}`);
  }

  protected selectLikeThis(block: LaidOutBlock): void {
    const book = this.opening()?.book;
    if (!book) return;
    const like = book.blocks.filter((b) => b.category_id === block.category_id).map((b) => b.id);
    this.selected.set(like);
    this.log(`select like this → ${like.length} ${block.category_id} blocks`);
  }

  protected deleteLikeThis(block: LaidOutBlock): void {
    const book = this.opening()?.book;
    if (!book) return;
    const like = book.blocks.filter((b) => b.category_id === block.category_id).map((b) => b.id);
    this.strikeIds(like);
    this.log(`strike like this → ${like.length} ${block.category_id} blocks`);
  }

  protected strikeSelection(): void { this.strikeIds(this.selected()); }

  protected strikeIds(ids: readonly string[]): void {
    const next = new Set(this.struck());
    for (const id of ids) { if (next.has(id)) next.delete(id); else next.add(id); }
    this.struck.set(next);
    this.log(`${next.size} struck`);
  }

  protected clearStrikes(): void { this.struck.set(new Set()); this.log('strikes cleared'); }
  protected clearSelection(): void { this.selected.set([]); this.log('selection cleared'); }

  protected togglePage(page: number): void {
    const next = new Set(this.struckPages());
    if (next.has(page)) next.delete(page); else next.add(page);
    this.struckPages.set(next);
    this.log(`page ${page + 1} ${next.has(page) ? 'excluded' : 'restored'}`);
  }

  protected onPageSelect(event: { pageNum: number; shiftKey: boolean; metaKey: boolean }): void {
    const next = new Set(event.shiftKey || event.metaKey ? this.selectedPageSet() : []);
    if (next.has(event.pageNum)) next.delete(event.pageNum); else next.add(event.pageNum);
    this.selectedPageSet.set(next);
    this.log(`page ${event.pageNum + 1} selected`);
  }

  protected selectAllOnPage(page: number): void {
    const book = this.opening()?.book;
    if (!book) return;
    const ids = book.blocks.filter((b) => b.page === page).map((b) => b.id);
    this.selected.set([...new Set([...this.selected(), ...ids])]);
    this.log(`selected ${ids.length} blocks on page ${page + 1}`);
  }

  protected deselectAllOnPage(page: number): void {
    const book = this.opening()?.book;
    if (!book) return;
    const onPage = new Set(book.blocks.filter((b) => b.page === page).map((b) => b.id));
    this.selected.set(this.selected().filter((id) => !onPage.has(id)));
    this.log(`deselected page ${page + 1}`);
  }

  protected onZoomChange(delta: number): void {
    this.zoom.set(Math.max(25, Math.min(400, Math.round(this.zoom() + delta))));
  }
}
