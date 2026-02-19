import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { LibraryService } from '../../../core/services/library.service';
import { StudioItem, StudioItemType, FetchUrlResult, EditAction } from '../models/studio.types';
import type { AudiobookOutput } from '../../../core/models/manifest.types';

/**
 * StudioService - Unified project management for books and articles
 *
 * Manages both:
 * - Books: BFP project files from ~/Documents/BookForge/projects/
 * - Articles: Language learning projects from ~/Documents/BookForge/language-learning/projects/
 */
@Injectable({
  providedIn: 'root'
})
export class StudioService {
  private readonly electronService = inject(ElectronService);
  private readonly libraryService = inject(LibraryService);

  // Reactive state
  private readonly _books = signal<StudioItem[]>([]);
  private readonly _articles = signal<StudioItem[]>([]);
  private readonly _archived = signal<StudioItem[]>([]);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  // Public computed signals
  readonly books = computed(() => this._books());
  readonly articles = computed(() => this._articles());
  readonly archived = computed(() => this._archived());
  readonly loading = computed(() => this._loading());
  readonly error = computed(() => this._error());

  // Combined count
  readonly totalCount = computed(() => this._books().length + this._articles().length);

  /**
   * Load all items (books and articles)
   */
  async loadAll(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this._archived.set([]);

    try {
      await Promise.all([
        this.loadBooks(),
        this.loadArticles()
      ]);
    } catch (e) {
      this._error.set((e as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Load books from manifest projects
   */
  async loadBooks(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    try {
      const result = await this.electronService.manifestList({ type: 'book' });
      if (!result.success || !result.projects) return;

      const projectsPath = this.libraryService.projectsPath();
      if (!projectsPath) return;

      // Collect ALL file paths to check across ALL books in one batch IPC call
      const allPaths: string[] = [];
      const bookPathMaps: Array<{ manifest: any; projectDir: string; paths: Record<string, string> }> = [];

      for (const manifest of result.projects) {
        const projectDir = `${projectsPath}/${manifest.projectId}`;
        const paths: Record<string, string> = {};

        // Standard audiobook
        if (manifest.outputs?.audiobook?.path) {
          paths['audiobook'] = `${projectDir}/${manifest.outputs.audiobook.path}`;
          if (manifest.outputs.audiobook.vttPath) {
            paths['vtt'] = `${projectDir}/${manifest.outputs.audiobook.vttPath}`;
          }
        }

        // Bilingual outputs
        if (manifest.outputs?.bilingualAudiobooks) {
          for (const [key, bilingual] of Object.entries(manifest.outputs.bilingualAudiobooks) as [string, AudiobookOutput][]) {
            paths[`bi-audio-${key}`] = `${projectDir}/${bilingual.path}`;
            if (bilingual.vttPath) {
              paths[`bi-vtt-${key}`] = `${projectDir}/${bilingual.vttPath}`;
            }
          }
        }

        // Cleanup
        paths['simplified'] = `${projectDir}/stages/01-cleanup/simplified.epub`;
        paths['cleaned'] = `${projectDir}/stages/01-cleanup/cleaned.epub`;
        paths['skipped'] = `${projectDir}/stages/01-cleanup/skipped-chunks.json`;

        // Source files
        paths['source-exported'] = `${projectDir}/source/exported.epub`;
        paths['source-original'] = `${projectDir}/source/original.epub`;
        paths['source-pdf'] = `${projectDir}/source/original.pdf`;

        allPaths.push(...Object.values(paths));
        bookPathMaps.push({ manifest, projectDir, paths });
      }

      // Single IPC call to check all paths at once
      const existsMap = await this.electronService.fsBatchExists(allPaths);

      // Process all books in parallel (cover loading is the only remaining IPC)
      const books = await Promise.all(bookPathMaps.map(async ({ manifest, projectDir, paths }) => {
        const exists = (key: string) => !!existsMap[paths[key]];

        // Standard audiobook
        let audiobookPath: string | undefined;
        let vttPath: string | undefined;
        if (paths['audiobook'] && exists('audiobook')) {
          audiobookPath = paths['audiobook'];
          if (paths['vtt'] && exists('vtt')) {
            vttPath = paths['vtt'];
          }
        }

        // Bilingual outputs
        let bilingualAudioPath: string | undefined;
        let bilingualVttPath: string | undefined;
        let bilingualSentencePairsPath: string | undefined;
        const bilingualOutputs: Record<string, { audioPath: string; vttPath: string; sentencePairsPath?: string; sourceLang: string; targetLang: string }> = {};

        if (manifest.outputs?.bilingualAudiobooks) {
          for (const [key, bilingual] of Object.entries(manifest.outputs.bilingualAudiobooks) as [string, AudiobookOutput][]) {
            if (!exists(`bi-audio-${key}`)) continue;

            const absAudio = paths[`bi-audio-${key}`];
            const vttKey = `bi-vtt-${key}`;
            const vttExists = paths[vttKey] ? exists(vttKey) : false;
            const absVtt = paths[vttKey];
            const absPairs = bilingual.sentencePairsPath ? `${projectDir}/${bilingual.sentencePairsPath}` : undefined;

            const [src, tgt] = key.split('-');
            bilingualOutputs[key] = {
              audioPath: absAudio,
              vttPath: vttExists ? absVtt : absAudio.replace('.m4b', '.vtt'),
              sentencePairsPath: absPairs,
              sourceLang: src,
              targetLang: tgt,
            };

            if (!bilingualAudioPath) {
              bilingualAudioPath = absAudio;
              bilingualVttPath = vttExists ? absVtt : undefined;
              bilingualSentencePairsPath = absPairs;
            }
          }
        }

        // Cleanup state
        let cleanedEpubPath: string | undefined;
        let hasCleaned = false;
        if (exists('simplified')) {
          cleanedEpubPath = paths['simplified'];
          hasCleaned = true;
        } else if (exists('cleaned')) {
          cleanedEpubPath = paths['cleaned'];
          hasCleaned = true;
        }

        let skippedChunksPath: string | undefined;
        if (hasCleaned && exists('skipped')) {
          skippedChunksPath = paths['skipped'];
        }

        // Source file (priority order)
        let epubPath = '';
        if (exists('source-exported')) epubPath = paths['source-exported'];
        else if (exists('source-original')) epubPath = paths['source-original'];
        else if (exists('source-pdf')) epubPath = paths['source-pdf'];
        if (!epubPath) epubPath = `${projectDir}/source/original.epub`;

        const book: StudioItem = {
          id: projectDir,
          type: 'book',
          title: manifest.metadata?.title || manifest.projectId,
          author: manifest.metadata?.author,
          year: manifest.metadata?.year,
          language: manifest.metadata?.language,
          status: this.mapBookStatus(audiobookPath || bilingualAudioPath, hasCleaned),
          createdAt: manifest.createdAt,
          modifiedAt: manifest.modifiedAt,
          epubPath,
          bfpPath: projectDir,
          coverPath: manifest.metadata?.coverPath ? `${this.libraryService.libraryPath()}/${manifest.metadata.coverPath}` : undefined,
          hasCleaned,
          cleanedEpubPath,
          audiobookPath,
          vttPath,
          skippedChunksPath,
          bilingualAudioPath,
          bilingualVttPath,
          bilingualSentencePairsPath,
          bilingualOutputs: Object.keys(bilingualOutputs).length > 0 ? bilingualOutputs : undefined,
          outputFilename: manifest.metadata?.outputFilename,
          contributors: manifest.metadata?.contributors,
          archived: manifest.archived,
          sortOrder: manifest.sortOrder,
        };

        // Load cover image (coverPath is library-relative)
        if (manifest.metadata?.coverPath) {
          try {
            const coverResult = await this.electronService.mediaLoadImage(manifest.metadata.coverPath);
            if (coverResult.success && coverResult.data) {
              book.coverData = coverResult.data;
            }
          } catch {
            // Cover not found, continue without it
          }
        }

        return book;
      }));

      // Separate archived books
      const activeBooks = books.filter(b => !b.archived);
      const archivedBooks = books.filter(b => b.archived);

      // Sort: items with sortOrder first (ascending), then by modifiedAt descending
      this.sortItems(activeBooks);
      this.sortItems(archivedBooks);

      this._books.set(activeBooks);
      // Merge archived books into the archived signal (combined with archived articles)
      this._archived.update(existing => {
        const withoutBooks = existing.filter(i => i.type !== 'book');
        return [...withoutBooks, ...archivedBooks];
      });
    } catch (e) {
      console.error('[StudioService] Failed to load books:', e);
    }
  }

  /**
   * Load articles from manifest projects
   */
  async loadArticles(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    try {
      const result = await this.electronService.manifestList({ type: 'article' });
      if (!result.success || !result.projects) return;

      const projectsPath = this.libraryService.projectsPath();
      if (!projectsPath) return;

      // Collect all paths for batch existence check
      const allPaths: string[] = [];
      const articlePathMaps: Array<{ manifest: any; projectDir: string; paths: Record<string, string> }> = [];

      for (const manifest of result.projects) {
        const projectDir = `${projectsPath}/${manifest.projectId}`;
        const paths: Record<string, string> = {
          'simplified': `${projectDir}/stages/01-cleanup/simplified.epub`,
          'cleaned': `${projectDir}/stages/01-cleanup/cleaned.epub`,
          'source-exported': `${projectDir}/source/exported.epub`,
          'source-original': `${projectDir}/source/original.epub`,
          'source-pdf': `${projectDir}/source/original.pdf`,
        };
        allPaths.push(...Object.values(paths));
        articlePathMaps.push({ manifest, projectDir, paths });
      }

      // Single IPC call for all articles
      const existsMap = await this.electronService.fsBatchExists(allPaths);

      const articles: StudioItem[] = articlePathMaps.map(({ manifest, projectDir, paths }) => {
        const exists = (key: string) => !!existsMap[paths[key]];

        const hasCleaned = exists('simplified') || exists('cleaned');
        const hasAudiobook = !!manifest.outputs?.audiobook?.path;
        let status: StudioItem['status'] = 'draft';
        if (hasAudiobook) status = 'completed';
        else if (hasCleaned) status = 'ready';

        let articleEpubPath = '';
        if (exists('source-exported')) articleEpubPath = paths['source-exported'];
        else if (exists('source-original')) articleEpubPath = paths['source-original'];
        else if (exists('source-pdf')) articleEpubPath = paths['source-pdf'];
        if (!articleEpubPath) articleEpubPath = `${projectDir}/source/original.epub`;

        return {
          id: manifest.projectId,
          type: 'article' as const,
          title: manifest.metadata?.title || 'Untitled',
          author: manifest.metadata?.author || manifest.metadata?.byline,
          status,
          createdAt: manifest.createdAt,
          modifiedAt: manifest.modifiedAt,
          sourceUrl: manifest.source?.url,
          sourceLang: manifest.metadata?.language || 'en',
          byline: manifest.metadata?.byline,
          excerpt: manifest.metadata?.excerpt,
          wordCount: manifest.metadata?.wordCount,
          epubPath: articleEpubPath,
          bfpPath: projectDir,
          hasCleaned,
          archived: manifest.archived,
          sortOrder: manifest.sortOrder,
        };
      });

      // Separate archived articles
      const activeArticles = articles.filter(a => !a.archived);
      const archivedArticles = articles.filter(a => a.archived);

      // Sort: items with sortOrder first (ascending), then by modifiedAt descending
      this.sortItems(activeArticles);
      this.sortItems(archivedArticles);

      this._articles.set(activeArticles);
      // Merge archived articles into the archived signal (combined with archived books)
      this._archived.update(existing => {
        const withoutArticles = existing.filter(i => i.type !== 'article');
        return [...withoutArticles, ...archivedArticles];
      });
    } catch (e) {
      console.error('[StudioService] Failed to load articles:', e);
    }
  }

  /**
   * Map book project state to unified status
   * @param audiobookPath - The resolved audiobook path (computed during loading)
   * @param hasCleaned - Whether the book has been through AI cleanup
   */
  private mapBookStatus(audiobookPath?: string, hasCleaned?: boolean): StudioItem['status'] {
    if (audiobookPath) return 'completed';
    if (hasCleaned) return 'ready';
    return 'draft';
  }

  /**
   * Map article project status to unified status
   */
  private mapArticleStatus(status: string): StudioItem['status'] {
    switch (status) {
      case 'completed': return 'completed';
      case 'processing': return 'processing';
      case 'error': return 'error';
      case 'selected':
      case 'fetched':
      default: return 'draft';
    }
  }

  /**
   * Get a single item by ID
   */
  getItem(id: string): StudioItem | undefined {
    return this._books().find(b => b.id === id) ||
           this._articles().find(a => a.id === id) ||
           this._archived().find(a => a.id === id);
  }

  /**
   * Add book from EPUB file
   * Creates a BFP project file and audiobook folder for the EPUB
   */
  async addBook(epubPath: string): Promise<{ success: boolean; item?: StudioItem; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      // Import EPUB - this creates both a BFP file and audiobook folder
      const result = await this.electronService.audiobookImportEpub(epubPath);

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to import EPUB' };
      }

      // Reload books to get the new item
      await this.loadBooks();

      // Find the newly added book by BFP path
      const newBook = this._books().find(b => b.bfpPath === result.bfpPath);

      if (newBook) {
        return { success: true, item: newBook };
      }

      // If we can't find it specifically, return success and let the UI refresh
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Add article from URL
   */
  async addArticle(url: string): Promise<{ success: boolean; item?: StudioItem; error?: string }> {
    if (!this.electronService.isRunningInElectron) {
      return { success: false, error: 'Not running in Electron' };
    }

    try {
      // Generate projectId BEFORE fetching so files are saved in the correct directory
      const projectId = crypto.randomUUID();

      // Fetch URL content using ElectronService, passing our projectId
      const result = await this.electronService.languageLearningFetchUrl(url, projectId);

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to fetch URL' };
      }

      // Create project using the same projectId
      const article: StudioItem = {
        id: projectId,
        type: 'article',
        title: result.title || 'Untitled',
        author: result.byline,
        status: 'draft',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        sourceUrl: url,
        htmlPath: result.htmlPath,  // Now points to correct directory
        deletedSelectors: [],
        sourceLang: 'en',
        targetLang: 'de',
        byline: result.byline,
        excerpt: result.excerpt,
        wordCount: result.wordCount,
        content: result.content,
        textContent: result.textContent
      };

      // Save project using ElectronService
      const saveResult = await this.electronService.languageLearningSaveProject({
        id: article.id,
        sourceUrl: article.sourceUrl,
        title: article.title,
        byline: article.byline,
        excerpt: article.excerpt,
        wordCount: article.wordCount,
        sourceLang: article.sourceLang,
        targetLang: article.targetLang,
        status: 'fetched',
        htmlPath: article.htmlPath,
        content: article.content,
        textContent: article.textContent,
        deletedSelectors: [],
        createdAt: article.createdAt,
        modifiedAt: article.modifiedAt
      });

      if (!saveResult.success) {
        return { success: false, error: saveResult.error || 'Failed to save project' };
      }

      // Add to local state
      this._articles.update(articles => [...articles, article]);

      return { success: true, item: article };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Update article (for content editing)
   */
  async updateArticle(
    id: string,
    updates: {
      deletedSelectors?: string[];
      undoStack?: EditAction[];
      redoStack?: EditAction[];
      targetLang?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const article = this._articles().find(a => a.id === id);
    if (!article) {
      return { success: false, error: 'Article not found' };
    }

    try {
      // Update local state
      const updated: StudioItem = {
        ...article,
        ...updates,
        modifiedAt: new Date().toISOString()
      };

      this._articles.update(articles =>
        articles.map(a => a.id === id ? updated : a)
      );

      // Save to disk using ElectronService
      const saveResult = await this.electronService.languageLearningSaveProject({
        id: updated.id,
        sourceUrl: updated.sourceUrl,
        title: updated.title,
        byline: updated.byline,
        excerpt: updated.excerpt,
        wordCount: updated.wordCount,
        sourceLang: updated.sourceLang,
        targetLang: updated.targetLang,
        status: 'fetched',
        htmlPath: updated.htmlPath,
        content: updated.content,
        textContent: updated.textContent,
        deletedSelectors: updated.deletedSelectors || [],
        undoStack: updated.undoStack || [],
        redoStack: updated.redoStack || [],
        createdAt: updated.createdAt,
        modifiedAt: updated.modifiedAt
      });

      return { success: saveResult.success, error: saveResult.error };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Delete an item (book or article)
   * For books: deletes BFP file, audiobook folder, backup file, and clears cache
   * For articles: deletes project folder
   */
  async deleteItem(id: string): Promise<{ success: boolean; error?: string }> {
    const book = this._books().find(b => b.id === id);
    const article = this._articles().find(a => a.id === id);

    if (book && book.bfpPath) {
      try {
        // Delete book project using projects:delete handler
        // This properly deletes: BFP file, audiobook folder, .bak file, and clears cache
        const result = await this.electronService.projectsDelete([book.bfpPath]);
        if (result.success) {
          this._books.update(books => books.filter(b => b.id !== id));
        }
        return { success: result.success, error: result.error };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }

    if (article) {
      try {
        // Delete article project using ElectronService
        const result = await this.electronService.languageLearningDeleteProject(id);
        if (result.success) {
          this._articles.update(articles => articles.filter(a => a.id !== id));
        }
        return result;
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }

    return { success: false, error: 'Item not found' };
  }

  /**
   * Reload a specific item
   */
  async reloadItem(id: string): Promise<void> {
    const book = this._books().find(b => b.id === id);
    const article = this._articles().find(a => a.id === id);

    if (book) {
      await this.loadBooks();
    } else if (article) {
      await this.loadArticles();
    }
  }

  /**
   * Update book metadata (saves to BFP file and updates local state)
   */
  async updateBookMetadata(
    id: string,
    metadata: {
      title?: string;
      author?: string;
      year?: string;
      language?: string;
      coverPath?: string;
      coverData?: string;
      outputFilename?: string;
      contributors?: Array<{ first: string; last: string }>;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const book = this._books().find(b => b.id === id);
    if (!book || !book.bfpPath) {
      return { success: false, error: 'Book not found' };
    }

    try {
      // Save to BFP file
      const result = await this.electronService.projectUpdateMetadata(book.bfpPath, metadata);

      if (!result.success) {
        return result;
      }

      // Update local state immediately with all metadata fields
      this._books.update(books =>
        books.map(b => b.id === id ? {
          ...b,
          title: metadata.title ?? b.title,
          author: metadata.author ?? b.author,
          year: metadata.year ?? b.year,
          language: metadata.language ?? b.language,
          coverData: metadata.coverData ?? b.coverData,
          outputFilename: metadata.outputFilename ?? b.outputFilename,
          contributors: metadata.contributors ?? b.contributors,
          modifiedAt: new Date().toISOString()
        } : b)
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Finalize article content for processing
   * Saves the filtered HTML and marks content as finalized
   */
  async finalizeArticleContent(
    id: string,
    finalizedHtml: string
  ): Promise<{ success: boolean; error?: string }> {
    const article = this._articles().find(a => a.id === id);
    if (!article) {
      return { success: false, error: 'Article not found' };
    }

    try {
      // Save finalized content using IPC handler
      const result = await this.electronService.languageLearningFinalizeContent(
        id,
        finalizedHtml
      );

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to finalize content' };
      }

      // Update local state
      this._articles.update(articles =>
        articles.map(a => a.id === id ? {
          ...a,
          contentFinalized: true,
          modifiedAt: new Date().toISOString()
        } : a)
      );

      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /**
   * Sort items: items with sortOrder first (ascending), then by modifiedAt descending
   */
  private sortItems(items: StudioItem[]): void {
    items.sort((a, b) => {
      const aHasOrder = a.sortOrder !== undefined;
      const bHasOrder = b.sortOrder !== undefined;
      if (aHasOrder && bHasOrder) return a.sortOrder! - b.sortOrder!;
      if (aHasOrder) return -1;
      if (bHasOrder) return 1;
      return new Date(b.modifiedAt || 0).getTime() - new Date(a.modifiedAt || 0).getTime();
    });
  }

  /**
   * Archive one or more items (move to Archived section)
   */
  async archiveItems(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = this.getItem(id);
      if (!item) continue;
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, archived: true });
    }
    await this.loadAll();
  }

  /**
   * Unarchive one or more items (move back to their original sections)
   */
  async unarchiveItems(ids: string[]): Promise<void> {
    for (const id of ids) {
      const item = this._archived().find(i => i.id === id);
      if (!item) continue;
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, archived: false });
    }
    await this.loadAll();
  }

  /**
   * Reorder items within a section by setting sortOrder on each item
   */
  async reorderItems(section: 'articles' | 'books' | 'archived', orderedIds: string[]): Promise<void> {
    const items = section === 'articles' ? this._articles()
      : section === 'books' ? this._books()
      : this._archived();

    // Optimistic local update
    const reordered = orderedIds
      .map(id => items.find(i => i.id === id))
      .filter((i): i is StudioItem => !!i)
      .map((item, idx) => ({ ...item, sortOrder: idx }));

    if (section === 'articles') this._articles.set(reordered);
    else if (section === 'books') this._books.set(reordered);
    else this._archived.set(reordered);

    // Persist sortOrder for each item
    for (let i = 0; i < orderedIds.length; i++) {
      const item = items.find(it => it.id === orderedIds[i]);
      if (!item) continue;
      const projectId = this.resolveProjectId(item);
      await this.electronService.manifestUpdate({ projectId, sortOrder: i });
    }
  }

  /**
   * Resolve the manifest projectId from a StudioItem.
   * Books use the project directory as id, but manifest needs the folder name (UUID).
   */
  private resolveProjectId(item: StudioItem): string {
    if (item.type === 'article') return item.id;
    // For books, item.id is the absolute project dir path — extract the folder name
    const parts = item.id.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Translate path for cross-platform compatibility (Syncthing shared library).
   * Uses the configured library root to re-root paths from other platforms.
   * Detects known library subdirectories (audiobooks/, files/, projects/, etc.)
   * and resolves relative to the current library root.
   */
  private translatePath(inputPath: string): string {
    if (!inputPath) return inputPath;

    const libraryRoot = this.libraryService.libraryPath();
    if (!libraryRoot) return inputPath;

    // Normalize to forward slashes for matching
    const normalized = inputPath.replace(/\\/g, '/');

    // Known library subdirectories
    const knownSubdirs = ['/audiobooks/', '/files/', '/projects/', '/media/', '/cache/'];

    for (const subdir of knownSubdirs) {
      const idx = normalized.indexOf(subdir);
      if (idx !== -1) {
        // Extract relative path from the subdir onwards (e.g., "audiobooks/MyBook/source.epub")
        const relativePart = normalized.substring(idx + 1); // Skip leading /
        // Construct path using library root and relative part
        const rootNormalized = libraryRoot.replace(/\\/g, '/');
        return `${rootNormalized}/${relativePart}`;
      }
    }

    return inputPath;
  }
}
