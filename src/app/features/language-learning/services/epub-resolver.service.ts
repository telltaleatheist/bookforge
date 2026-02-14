import { Injectable, inject } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { EpubResolutionContext, ResolvedEpub } from '../models/language-learning.types';

/**
 * Service responsible for resolving EPUB files based on context.
 *
 * Key principles:
 * 1. Language Learning pipeline needs sentence-per-paragraph EPUBs (e.g., en.epub, de.epub)
 * 2. Standard pipeline uses full-text EPUBs (cleaned.epub, exported.epub, etc.)
 * 3. Resolution happens at runtime, not configuration time
 * 4. Clear fallback hierarchy for robustness
 */
@Injectable({
  providedIn: 'root'
})
export class EpubResolverService {
  private electronService = inject(ElectronService);

  /**
   * Resolve the appropriate EPUB file for a given context.
   * For Language Learning: Prioritizes language-specific EPUBs with sentence-per-paragraph format.
   * For Standard: Uses cleaned/finalized/original with full text.
   */
  async resolveEpub(context: EpubResolutionContext): Promise<ResolvedEpub> {
    // Always use projectDir for unified structure
    const searchDir = context.projectDir;

    if (!searchDir) {
      return {
        path: '',
        source: 'fallback',
        exists: false
      };
    }

    // For Language Learning pipeline, we need language-specific EPUBs
    if (context.pipeline === 'language-learning') {
      return this.resolveLanguageLearningEpub(searchDir, context.language);
    }

    // For Standard pipeline, use full-text EPUBs
    return this.resolveStandardEpub(searchDir);
  }

  /**
   * Resolve EPUB for Language Learning pipeline.
   * These EPUBs have sentence-per-paragraph format for interleaving.
   */
  private async resolveLanguageLearningEpub(dir: string, language: string): Promise<ResolvedEpub> {
    console.log(`[EPUB-RESOLVER] Resolving Language Learning EPUB for language: ${language} in dir: ${dir}`);

    // For unified projects, language EPUBs are in stages/02-translate/
    const translationDir = `${dir}/stages/02-translate`;

    // List all files in translation directory for debugging
    try {
      const files = await this.electronService.listDirectory(translationDir);
      console.log(`[EPUB-RESOLVER] Files in ${translationDir}:`, files.filter(f => f.endsWith('.epub')));
    } catch (err) {
      console.error(`[EPUB-RESOLVER] Failed to list translation directory:`, err);
    }

    // Priority 1: Language-specific EPUB in translation stage (e.g., en.epub, de.epub)
    const languageEpubPath = `${translationDir}/${language}.epub`;
    const languageExists = await this.fileExists(languageEpubPath);

    console.log(`[EPUB-RESOLVER] Checking for ${language}.epub at ${languageEpubPath}: exists=${languageExists}`);

    if (languageExists) {
      console.log(`[EPUB-RESOLVER] ✓ Found language-specific EPUB: ${language}.epub`);
      return {
        path: languageEpubPath,
        source: 'language',
        exists: true,
        sentenceCount: undefined // Will be determined at runtime
      };
    }

    // Priority 2a: Simplified EPUB (most processed)
    const simplifiedPath = `${dir}/stages/01-cleanup/simplified.epub`;
    const simplifiedExists = await this.fileExists(simplifiedPath);

    if (simplifiedExists) {
      console.warn(`[EPUB-RESOLVER] ⚠️ No ${language}.epub found, falling back to simplified.epub`);
      console.warn(`[EPUB-RESOLVER] This will process the full text, not sentence-per-paragraph format!`);
      return {
        path: simplifiedPath,
        source: 'simplified',
        exists: true
      };
    }

    // Priority 2b: Cleaned EPUB
    const cleanedPath = `${dir}/stages/01-cleanup/cleaned.epub`;
    const cleanedExists = await this.fileExists(cleanedPath);

    if (cleanedExists) {
      console.warn(`[EPUB-RESOLVER] ⚠️ No ${language}.epub found, falling back to cleaned.epub`);
      console.warn(`[EPUB-RESOLVER] This will process the full text, not sentence-per-paragraph format!`);
      return {
        path: cleanedPath,
        source: 'cleaned',
        exists: true
      };
    }

    // Priority 3: Exported (user-edited from PDF picker, in source folder)
    const exportedPath = `${dir}/source/exported.epub`;
    const exportedExists = await this.fileExists(exportedPath);

    if (exportedExists) {
      console.warn(`[EPUB-RESOLVER] ⚠️ Using exported.epub as fallback`);
      return {
        path: exportedPath,
        source: 'exported',
        exists: true
      };
    }

    // Priority 4: Original
    const originalPath = `${dir}/source/original.epub`;
    const originalExists = await this.fileExists(originalPath);

    if (originalExists) {
      console.warn(`[EPUB-RESOLVER] ⚠️ Using original.epub as last resort`);
      return {
        path: originalPath,
        source: 'original',
        exists: true
      };
    }

    // No EPUB found - return path where it should be created
    console.log(`[EPUB-RESOLVER] No EPUB found, expecting: ${languageEpubPath}`);
    return {
      path: languageEpubPath,
      source: 'fallback',
      exists: false
    };
  }

  /**
   * Resolve EPUB for Standard pipeline.
   * Uses full-text EPUBs for regular audiobook production.
   */
  private async resolveStandardEpub(dir: string): Promise<ResolvedEpub> {
    // Priority 1a: Simplified EPUB (most processed) in stages
    const simplifiedPath = `${dir}/stages/01-cleanup/simplified.epub`;
    const simplifiedExists = await this.fileExists(simplifiedPath);

    if (simplifiedExists) {
      return {
        path: simplifiedPath,
        source: 'simplified',
        exists: true
      };
    }

    // Priority 1b: Cleaned EPUB (AI-processed) in stages
    const cleanedPath = `${dir}/stages/01-cleanup/cleaned.epub`;
    const cleanedExists = await this.fileExists(cleanedPath);

    if (cleanedExists) {
      return {
        path: cleanedPath,
        source: 'cleaned',
        exists: true
      };
    }

    // Priority 2: Exported EPUB (user-edited from PDF picker) in source
    const exportedPath = `${dir}/source/exported.epub`;
    const exportedExists = await this.fileExists(exportedPath);

    if (exportedExists) {
      return {
        path: exportedPath,
        source: 'exported',
        exists: true
      };
    }

    // Priority 3: Original EPUB in source
    const originalPath = `${dir}/source/original.epub`;
    const originalExists = await this.fileExists(originalPath);

    if (originalExists) {
      return {
        path: originalPath,
        source: 'original',
        exists: true
      };
    }

    // No EPUB found
    return {
      path: `${dir}/source/original.epub`,
      source: 'fallback',
      exists: false
    };
  }

  /**
   * List all available EPUBs in a directory with their metadata.
   */
  async listAvailableEpubs(dir: string): Promise<{
    filename: string;
    path: string;
    isLanguageEpub: boolean;
    language?: string;
  }[]> {
    if (!dir) return [];

    try {
      const files = await this.electronService.listDirectory(dir);
      const epubs = [];

      for (const file of files) {
        // Skip macOS resource forks and hidden files
        if (file.startsWith('._') || file.startsWith('.')) continue;

        if (file.endsWith('.epub')) {
          const isLanguageEpub = /^[a-z]{2}\.epub$/i.test(file);
          const language = isLanguageEpub ? file.slice(0, 2).toLowerCase() : undefined;

          epubs.push({
            filename: file,
            path: `${dir}/${file}`,
            isLanguageEpub,
            language
          });
        }
      }

      return epubs;
    } catch (err) {
      console.error('[EPUB-RESOLVER] Failed to list EPUBs:', err);
      return [];
    }
  }

  /**
   * Detect available languages from EPUB files.
   * Returns language codes that have corresponding EPUBs.
   */
  async detectAvailableLanguages(dir: string): Promise<string[]> {
    const epubs = await this.listAvailableEpubs(dir);
    const languages = epubs
      .filter(e => e.isLanguageEpub && e.language)
      .map(e => e.language as string);

    return [...new Set(languages)]; // Remove duplicates
  }

  /**
   * Check if a file exists by checking if it's in the parent directory.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const parts = filePath.split('/');
      const fileName = parts.pop();
      const dirPath = parts.join('/');

      if (!fileName || !dirPath) return false;

      const files = await this.electronService.listDirectory(dirPath);
      return files.includes(fileName);
    } catch {
      return false;
    }
  }
}