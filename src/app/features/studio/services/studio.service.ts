import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { LibraryService } from '../../../core/services/library.service';
import { StudioItem, StudioItemType, FetchUrlResult, EditAction } from '../models/studio.types';

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
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  // Public computed signals
  readonly books = computed(() => this._books());
  readonly articles = computed(() => this._articles());
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
   * Load books from BFP files
   */
  async loadBooks(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    try {
      // Use the correct IPC handler: listProjectsWithAudiobook
      const result = await this.electronService.audiobookListProjectsWithAudiobook();

      if (result.success && result.projects) {
        const books: StudioItem[] = [];

        for (const p of result.projects) {
          console.log(`[StudioService] Processing book: ${p.name}`);
          console.log(`[StudioService]   audiobookFolder: ${p.audiobookFolder}`);
          console.log(`[StudioService]   linkedAudioPath: ${p.linkedAudioPath}`);
          console.log(`[StudioService]   vttPath from BFP: ${p.vttPath}`);
          console.log(`[StudioService]   outputFilename: ${p.metadata?.outputFilename}`);

          // Determine audio path - prioritize linkedAudioPath from BFP, then check for output.m4b
          let audiobookPath: string | undefined;

          // First check linkedAudioPath from BFP (supports custom filenames)
          if (p.linkedAudioPath && p.linkedAudioPathValid !== false) {
            const translatedPath = this.translatePath(p.linkedAudioPath);
            const linkedExists = await this.electronService.fsExists(translatedPath);
            if (linkedExists) {
              audiobookPath = translatedPath;
              console.log(`[StudioService]   -> Using linkedAudioPath: ${audiobookPath}`);
            }
          }

          // Fall back to output.m4b in audiobook folder
          if (!audiobookPath && p.audiobookFolder) {
            // Translate path for cross-platform compatibility (Syncthing shared library)
            const folder = this.translatePath(p.audiobookFolder);
            const outputM4b = `${folder}/output.m4b`;
            const outputExists = await this.electronService.fsExists(outputM4b);
            if (outputExists) {
              audiobookPath = outputM4b;
            }
          }

          // VTT file - check audiobook folder
          let vttPath: string | undefined;
          if (p.audiobookFolder) {
            const folder = this.translatePath(p.audiobookFolder);
            const vttFile = `${folder}/subtitles.vtt`;
            const vttExists = await this.electronService.fsExists(vttFile);
            if (vttExists) {
              vttPath = vttFile;
            }
          }

          console.log(`[StudioService]   RESULT: audiobookPath=${audiobookPath}, vttPath=${vttPath}`);

          // Skipped chunks file - only set if it exists
          let skippedChunksPath: string | undefined;
          if (p.audiobookFolder && p.cleanedAt) {
            const skippedFile = `${p.audiobookFolder}/skipped-chunks.json`;
            const skippedExists = await this.electronService.fsExists(skippedFile);
            if (skippedExists) {
              skippedChunksPath = skippedFile;
            }
          }

          // Check for bilingual audio path
          let bilingualAudioPath: string | undefined;
          let bilingualVttPath: string | undefined;
          if (p.bilingualAudioPath && p.bilingualAudioPathValid !== false) {
            bilingualAudioPath = p.bilingualAudioPath;
            console.log(`[StudioService]   -> Found bilingualAudioPath: ${bilingualAudioPath}`);
          }
          if (p.bilingualVttPath) {
            const bilingualVttExists = await this.electronService.fsExists(p.bilingualVttPath);
            if (bilingualVttExists) {
              bilingualVttPath = p.bilingualVttPath;
              console.log(`[StudioService]   -> Found bilingualVttPath: ${bilingualVttPath}`);
            }
          }

          const book: StudioItem = {
            id: p.bfpPath,  // Use bfpPath as unique ID
            type: 'book' as StudioItemType,
            title: p.metadata?.title || p.name || 'Untitled',
            author: p.metadata?.author,
            year: p.metadata?.year,
            language: p.metadata?.language,
            status: this.mapBookStatus(audiobookPath, !!p.cleanedAt),
            createdAt: p.exportedAt || new Date().toISOString(),
            modifiedAt: p.cleanedAt || p.exportedAt || new Date().toISOString(),
            epubPath: p.audiobookFolder ? `${p.audiobookFolder}/exported.epub` : undefined,
            bfpPath: p.bfpPath,
            coverPath: p.metadata?.coverImagePath,
            hasCleaned: !!p.cleanedAt,
            // Only set cleanedEpubPath if the book was actually cleaned (cleanedAt exists)
            cleanedEpubPath: (p.cleanedAt && p.audiobookFolder) ? `${p.audiobookFolder}/exported_cleaned.epub` : undefined,
            audiobookPath,
            vttPath,
            skippedChunksPath,
            // Bilingual audio paths
            bilingualAudioPath,
            bilingualVttPath
          };

          // Load cover image as base64 for display
          if (p.metadata?.coverImagePath) {
            try {
              const coverResult = await this.electronService.mediaLoadImage(p.metadata.coverImagePath);
              if (coverResult.success && coverResult.data) {
                book.coverData = coverResult.data;
              }
            } catch {
              // Cover not found, continue without it
            }
          }

          books.push(book);
        }

        this._books.set(books);
      }
    } catch (e) {
      console.error('[StudioService] Failed to load books:', e);
    }
  }

  /**
   * Load articles from language learning projects
   */
  async loadArticles(): Promise<void> {
    if (!this.electronService.isRunningInElectron) {
      return;
    }

    try {
      // Use ElectronService wrapper for language learning projects
      const result = await this.electronService.languageLearningListProjects();

      if (result.success && result.projects) {
        const articles: StudioItem[] = result.projects.map((p: any) => ({
          id: p.id,
          type: 'article' as StudioItemType,
          title: p.title || 'Untitled',
          author: p.byline,
          status: this.mapArticleStatus(p.status),
          createdAt: p.createdAt || new Date().toISOString(),
          modifiedAt: p.modifiedAt || new Date().toISOString(),
          sourceUrl: p.sourceUrl,
          htmlPath: p.htmlPath,
          epubPath: p.epubPath,  // Generated by Finalize
          deletedSelectors: p.deletedSelectors || [],
          undoStack: p.undoStack || [],
          redoStack: p.redoStack || [],
          sourceLang: p.sourceLang || 'en',
          targetLang: p.targetLang || 'de',
          byline: p.byline,
          excerpt: p.excerpt,
          wordCount: p.wordCount,
          content: p.content,
          textContent: p.textContent,
          contentFinalized: p.contentFinalized || false,
          hasCleaned: p.hasCleaned || false,  // Whether AI cleanup has been run
          cleanedEpubPath: p.cleanedEpubPath,  // Add cleaned EPUB path for review tab
          audiobookPath: p.audiobookPath,
          vttPath: p.vttPath,
          errorMessage: p.errorMessage
        }));

        this._articles.set(articles);
      }
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
           this._articles().find(a => a.id === id);
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
   * Translate path for cross-platform compatibility (Syncthing shared library)
   * Windows: E:\Shared\BookForge\... <-> Mac: /Volumes/Callisto/Shared/BookForge/...
   */
  private translatePath(inputPath: string): string {
    if (!inputPath) return inputPath;

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const isWindowsPath = /^[A-Z]:\\/i.test(inputPath);
    const isMacPath = inputPath.startsWith('/Volumes/');

    if (isMac && isWindowsPath) {
      // Windows path on Mac: E:\Shared\... -> /Volumes/Callisto/Shared/...
      return `/Volumes/Callisto${inputPath.substring(2).replace(/\\/g, '/')}`;
    } else if (!isMac && isMacPath) {
      // Mac path on Windows: /Volumes/Callisto/Shared/... -> E:\Shared\...
      return `E:${inputPath.replace('/Volumes/Callisto', '').replace(/\//g, '\\')}`;
    }

    return inputPath;
  }
}
