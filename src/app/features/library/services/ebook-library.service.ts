import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import type { LibraryBook, Category, DuplicateInfo } from '../models/library.types';

@Injectable({
  providedIn: 'root'
})
export class EbookLibraryService {
  private readonly electronService = inject(ElectronService);

  // Private writable state
  private readonly _books = signal<LibraryBook[]>([]);
  private readonly _categories = signal<Category[]>([]);
  private readonly _selectedBookPath = signal<string | null>(null);
  private readonly _loading = signal(false);
  private readonly _searchQuery = signal('');
  private readonly _activeCategory = signal('All Books');
  private readonly _sortBy = signal<'title' | 'author' | 'year' | 'dateAdded'>('dateAdded');
  private readonly _sortAsc = signal(false);
  private readonly _formatFilter = signal<string[]>([]);
  private readonly _ebookMetaAvailable = signal(false);
  private readonly _selectedBooks = signal<Set<string>>(new Set());

  // Public read-only
  readonly books = computed(() => this._books());
  readonly categories = computed(() => this._categories());
  readonly loading = computed(() => this._loading());
  readonly searchQuery = computed(() => this._searchQuery());
  readonly activeCategory = computed(() => this._activeCategory());
  readonly sortBy = computed(() => this._sortBy());
  readonly sortAsc = computed(() => this._sortAsc());
  readonly formatFilter = computed(() => this._formatFilter());
  readonly ebookMetaAvailable = computed(() => this._ebookMetaAvailable());
  readonly selectedBookPath = computed(() => this._selectedBookPath());
  readonly selectedBooks = computed(() => this._selectedBooks());

  readonly selectedBook = computed(() => {
    const path = this._selectedBookPath();
    if (!path) return null;
    return this._books().find(b => b.relativePath === path) || null;
  });

  readonly filteredBooks = computed(() => {
    let result = this._books();

    // Category filter
    const category = this._activeCategory();
    if (category !== 'All Books') {
      result = result.filter(b => b.category === category);
    }

    // Format filter
    const formats = this._formatFilter();
    if (formats.length > 0) {
      result = result.filter(b => formats.includes(b.format));
    }

    // Search
    const query = this._searchQuery().toLowerCase();
    if (query) {
      result = result.filter(b =>
        b.title.toLowerCase().includes(query) ||
        (b.authorFull?.toLowerCase().includes(query)) ||
        (b.authorLast?.toLowerCase().includes(query)) ||
        (b.authorFirst?.toLowerCase().includes(query))
      );
    }

    // Sort
    const sortField = this._sortBy();
    const asc = this._sortAsc();
    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':
          cmp = (a.title || '').localeCompare(b.title || '');
          break;
        case 'author':
          cmp = (a.authorLast || a.authorFull || '').localeCompare(b.authorLast || b.authorFull || '');
          break;
        case 'year':
          cmp = (a.year || 0) - (b.year || 0);
          break;
        case 'dateAdded':
          cmp = (a.dateAdded || 0) - (b.dateAdded || 0);
          break;
      }
      return asc ? cmp : -cmp;
    });

    return result;
  });

  readonly bookCount = computed(() => this._books().length);

  readonly categoryBookCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const book of this._books()) {
      counts[book.category] = (counts[book.category] || 0) + 1;
    }
    return counts;
  });

  readonly availableFormats = computed(() => {
    const formats = new Set<string>();
    for (const book of this._books()) {
      formats.add(book.format);
    }
    return Array.from(formats).sort();
  });

  async init(): Promise<void> {
    this._loading.set(true);
    try {
      const result = await this.electronService.ebookLibraryInit();
      if (result.success && result.data) {
        this._ebookMetaAvailable.set(result.data.ebookMetaAvailable);
      }
      await this.loadBooks();
      await this.loadCategories();
    } finally {
      this._loading.set(false);
    }
    // Load covers in the background after UI renders
    this.loadAllCovers();
  }

  async loadBooks(): Promise<void> {
    const result = await this.electronService.ebookLibraryScan();
    if (result.success && result.data) {
      // Preserve already-loaded cover data across refreshes
      const existingCovers = new Map<string, string>();
      for (const book of this._books()) {
        if (book.coverData) {
          existingCovers.set(book.relativePath, book.coverData);
        }
      }

      const books = result.data.books.map((b: LibraryBook) => {
        const cover = existingCovers.get(b.relativePath);
        return cover ? { ...b, coverData: cover } : b;
      });

      this._books.set(books);
    }
  }

  private async loadAllCovers(): Promise<void> {
    const books = this._books().filter(b => !b.coverData);
    this.loadCoversForBooks(books);
  }

  /**
   * Load covers for specific books by their relative paths (used after addBooks)
   */
  private async loadCoversForPaths(paths: string[]): Promise<void> {
    const pathSet = new Set(paths);
    const books = this._books().filter(b => pathSet.has(b.relativePath) && !b.coverData);
    this.loadCoversForBooks(books);
  }

  private async loadCoversForBooks(books: LibraryBook[]): Promise<void> {
    if (books.length === 0) return;
    // Load covers in batches of 4 to avoid overwhelming IPC
    const batchSize = 4;
    for (let i = 0; i < books.length; i += batchSize) {
      const batch = books.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (book) => {
          const coverData = await this.getCover(book.relativePath);
          return { relativePath: book.relativePath, coverData };
        })
      );

      // Update books with cover data
      this._books.update(current =>
        current.map(b => {
          const match = results.find(r => r.relativePath === b.relativePath);
          if (match?.coverData) {
            return { ...b, coverData: match.coverData };
          }
          return b;
        })
      );
    }
  }

  async loadCategories(): Promise<void> {
    const result = await this.electronService.ebookLibraryListCategories();
    if (result.success && result.data) {
      this._categories.set(result.data.categories);
    }
  }

  async addBooks(paths: string[], category?: string): Promise<{ added: LibraryBook[]; duplicates: DuplicateInfo[] }> {
    const cat = category || this._activeCategory();
    const targetCategory = cat === 'All Books' ? 'Uncategorized' : cat;

    const result = await this.electronService.ebookLibraryAddBooks(paths, targetCategory);
    if (result.success && result.data) {
      await this.loadBooks();
      await this.loadCategories();
      // Load covers for newly added books
      const addedPaths = result.data.added.map((b: LibraryBook) => b.relativePath);
      if (addedPaths.length > 0) {
        this.loadCoversForPaths(addedPaths);
      }
      return result.data;
    }
    return { added: [], duplicates: [] };
  }

  async removeBook(relativePath: string): Promise<boolean> {
    const result = await this.electronService.ebookLibraryRemoveBook(relativePath);
    if (result.success) {
      if (this._selectedBookPath() === relativePath) {
        this._selectedBookPath.set(null);
      }
      await this.loadBooks();
      await this.loadCategories();
      return true;
    }
    return false;
  }

  async moveBooks(paths: string[], category: string): Promise<void> {
    // Remap cover data to new paths before the scan replaces the book list
    const pathMap = new Map<string, string>();
    for (const oldPath of paths) {
      const filename = oldPath.split('/').pop()!;
      const newPath = `${category}/${filename}`;
      pathMap.set(oldPath, newPath);
    }

    this._books.update(books =>
      books.map(b => {
        const newPath = pathMap.get(b.relativePath);
        if (newPath) {
          return { ...b, relativePath: newPath, category };
        }
        return b;
      })
    );

    const result = await this.electronService.ebookLibraryMoveBooks(paths, category);
    if (result.success) {
      await this.loadBooks();
      await this.loadCategories();
    }
  }

  async updateMetadata(relativePath: string, metadata: any): Promise<LibraryBook | null> {
    const result = await this.electronService.ebookLibraryUpdateMetadata(relativePath, metadata);
    if (result.success && result.data) {
      const updated = result.data.book;
      // If relativePath changed (file was renamed), remap in local state
      // so loadBooks() can preserve cover data under the new path
      if (updated.relativePath !== relativePath) {
        this._books.update(books =>
          books.map(b => b.relativePath === relativePath
            ? { ...b, relativePath: updated.relativePath, filename: updated.filename }
            : b)
        );
        this._selectedBookPath.set(updated.relativePath);
      }
      await this.loadBooks();
      return updated;
    }
    return null;
  }

  async getCover(relativePath: string): Promise<string | null> {
    const result = await this.electronService.ebookLibraryGetCover(relativePath);
    if (result.success && result.data) {
      return result.data.coverData;
    }
    return null;
  }

  async setCover(relativePath: string, base64Data: string): Promise<void> {
    await this.electronService.ebookLibrarySetCover(relativePath, base64Data);
    // Update just this book's cover in place — no full rescan needed
    this._books.update(books =>
      books.map(b => b.relativePath === relativePath ? { ...b, coverData: base64Data } : b)
    );
  }

  async createCategory(name: string): Promise<void> {
    const result = await this.electronService.ebookLibraryCreateCategory(name);
    if (result.success) {
      await this.loadCategories();
    }
  }

  async deleteCategory(name: string): Promise<void> {
    // Books in this category get moved to Uncategorized — remap paths so covers survive
    this._books.update(books =>
      books.map(b => {
        if (b.category === name) {
          return { ...b, relativePath: `Uncategorized/${b.filename}`, category: 'Uncategorized' };
        }
        return b;
      })
    );

    const result = await this.electronService.ebookLibraryDeleteCategory(name);
    if (result.success) {
      if (this._activeCategory() === name) {
        this._activeCategory.set('All Books');
      }
      await this.loadBooks();
      await this.loadCategories();
    }
  }

  async renameCategory(oldName: string, newName: string): Promise<void> {
    // Remap book paths before scan so covers are preserved under new keys
    this._books.update(books =>
      books.map(b => {
        if (b.category === oldName) {
          return { ...b, relativePath: `${newName}/${b.filename}`, category: newName };
        }
        return b;
      })
    );

    const result = await this.electronService.ebookLibraryRenameCategory(oldName, newName);
    if (result.success) {
      if (this._activeCategory() === oldName) {
        this._activeCategory.set(newName);
      }
      await this.loadBooks();
      await this.loadCategories();
    }
  }

  async importToStudio(relativePath: string): Promise<{ absolutePath: string; metadata: any } | null> {
    const result = await this.electronService.ebookLibraryImportToStudio(relativePath);
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  }

  selectBook(relativePath: string | null): void {
    this._selectedBookPath.set(relativePath);
    // Sync multi-selection: single-click sets exactly one item
    if (relativePath) {
      this._selectedBooks.set(new Set([relativePath]));
    } else {
      this._selectedBooks.set(new Set());
    }
  }

  setSelectedBooks(paths: Set<string>): void {
    this._selectedBooks.set(paths);
    // Keep metadata panel showing the most recently selected book
    if (paths.size === 1) {
      this._selectedBookPath.set([...paths][0]);
    } else if (paths.size === 0) {
      this._selectedBookPath.set(null);
    }
    // If multiple selected, keep current selectedBookPath as-is
  }

  toggleBookSelection(relativePath: string, additive: boolean): void {
    const current = new Set(this._selectedBooks());
    if (additive) {
      if (current.has(relativePath)) {
        current.delete(relativePath);
      } else {
        current.add(relativePath);
      }
    } else {
      current.clear();
      current.add(relativePath);
    }
    this._selectedBooks.set(current);
    // Update metadata panel to latest clicked
    if (current.size > 0) {
      this._selectedBookPath.set(relativePath);
    } else {
      this._selectedBookPath.set(null);
    }
  }

  setSearchQuery(query: string): void {
    this._searchQuery.set(query);
  }

  setActiveCategory(category: string): void {
    this._activeCategory.set(category);
  }

  toggleSortDir(): void {
    this._sortAsc.update(v => !v);
  }

  setSortBy(field: 'title' | 'author' | 'year' | 'dateAdded'): void {
    if (this._sortBy() === field) {
      this._sortAsc.update(v => !v);
    } else {
      this._sortBy.set(field);
      this._sortAsc.set(true);
    }
  }

  setFormatFilter(formats: string[]): void {
    this._formatFilter.set(formats);
  }
}
