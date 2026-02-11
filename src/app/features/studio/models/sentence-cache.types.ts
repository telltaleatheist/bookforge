/**
 * Sentence Cache Types
 *
 * Types for the sentence caching system used in bilingual TTS.
 * Cached sentences are stored per language in the audiobook project folder.
 *
 * Storage structure:
 * audiobooks/<book_name>/
 * ├── sentences/
 * │   ├── en.json          # Source language cache
 * │   ├── de.json          # German translation cache
 * │   └── ko.json          # Korean translation cache
 * ├── audio/
 * │   ├── en/              # English audio files
 * │   │   ├── 0001.wav
 * │   │   └── ...
 * │   └── de/              # German audio files
 * │       ├── 0001.wav
 * │       └── ...
 */

/**
 * TTS settings used to generate audio
 */
export interface CachedTtsSettings {
  engine: 'xtts' | 'orpheus';
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
}

/**
 * Chapter with sentences (for chaptered books)
 */
export interface CachedChapter {
  title: string;
  sentences: string[];
}

/**
 * Chapter with translation pairs
 */
export interface CachedTranslationChapter {
  title: string;  // Source language title
  translatedTitle: string;  // Translated title
  sentences: Array<{ source: string; target: string }>;
}

/**
 * Cache file for source language (extracted from EPUB)
 */
export interface SourceSentenceCache {
  language: string;
  sourceLanguage: null;
  createdAt: string;
  sentenceCount: number;
  // Flat sentences (legacy/simple format)
  sentences?: string[];
  // Chaptered sentences (new format)
  chapters?: CachedChapter[];
  // Audio fields (optional - present after TTS)
  hasAudio?: boolean;
  audioDir?: string;  // Relative path: "audio/en"
  ttsSettings?: CachedTtsSettings;
}

/**
 * Cache file for translated language
 */
export interface TranslationSentenceCache {
  language: string;
  sourceLanguage: string;
  createdAt: string;
  sentenceCount: number;
  // Flat sentences (legacy/simple format)
  sentences?: Array<{ source: string; target: string }>;
  // Chaptered sentences (new format)
  chapters?: CachedTranslationChapter[];
  // Audio fields (optional - present after TTS)
  hasAudio?: boolean;
  audioDir?: string;  // Relative path: "audio/de"
  ttsSettings?: CachedTtsSettings;
}

/**
 * Union type for sentence cache files
 */
export type SentenceCacheFile = SourceSentenceCache | TranslationSentenceCache;

/**
 * Type guard to check if cache is a source cache
 */
export function isSourceCache(cache: SentenceCacheFile): cache is SourceSentenceCache {
  return cache.sourceLanguage === null;
}

/**
 * Type guard to check if cache is a translation cache
 */
export function isTranslationCache(cache: SentenceCacheFile): cache is TranslationSentenceCache {
  return cache.sourceLanguage !== null;
}

/**
 * Info about a cached language (for UI display)
 */
export interface CachedLanguageInfo {
  code: string;
  name: string;
  sentenceCount: number;
  sourceLanguage: string | null;
  createdAt: string;
  // Audio info
  hasAudio: boolean;
  ttsSettings?: CachedTtsSettings;
}

/**
 * Result of listing cached languages
 */
export interface SentenceCacheListResult {
  success: boolean;
  languages: CachedLanguageInfo[];
  error?: string;
}

/**
 * Result of getting sentences for a language
 */
export interface SentenceCacheGetResult {
  success: boolean;
  cache?: SentenceCacheFile;
  error?: string;
}

/**
 * Result of saving sentences
 */
export interface SentenceCacheSaveResult {
  success: boolean;
  error?: string;
}

/**
 * Result of clearing cache
 */
export interface SentenceCacheClearResult {
  success: boolean;
  cleared: string[];
  error?: string;
}

/**
 * Assembly configuration for bilingual audio
 */
export interface BilingualAssemblyConfig {
  sourceLang: string;
  targetLangs: string[];
  pattern: 'interleaved' | 'sequential';  // interleaved: src1,tgt1,src2,tgt2 | sequential: all src, then all tgt
  pauseBetweenLanguages: number;  // ms
  pauseBetweenSentences: number;  // ms
  outputFormat: 'm4b' | 'mp3';
}
