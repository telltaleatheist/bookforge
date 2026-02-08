/**
 * Language Learning Types - Type definitions for the language learning feature
 */

// ─────────────────────────────────────────────────────────────────────────────
// Project Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectStatus = 'fetched' | 'selected' | 'processing' | 'completed' | 'error';

// Edit action for undo/redo
export interface EditAction {
  type: 'delete' | 'restore';
  selectors: string[];          // CSS selectors affected by this action
  timestamp: string;
}

export interface LanguageLearningProject {
  id: string;
  sourceUrl: string;
  title: string;
  byline?: string;              // Author info from Readability
  excerpt?: string;             // Article summary
  wordCount?: number;           // Word count
  sourceLang: string;           // 'en' (auto-detected or manual)
  targetLang: string;           // 'de', 'es', 'fr', etc. (user selected)
  status: ProjectStatus;

  // File paths
  htmlPath: string;             // Clean article HTML from Readability
  content?: string;             // Article HTML content (for preview)
  textContent?: string;         // Plain text content
  deletedSelectors: string[];   // CSS selectors for elements user removed

  // Undo/redo stacks
  undoStack?: EditAction[];     // Actions that can be undone
  redoStack?: EditAction[];     // Actions that can be redone

  // Outputs
  bilingualEpubPath?: string;
  audiobookPath?: string;
  vttPath?: string;

  // Error message if status is 'error'
  errorMessage?: string;

  // Timestamps
  createdAt: string;
  modifiedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Language Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface SupportedLanguage {
  code: string;
  name: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ko', name: 'Korean' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Job Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type AIProvider = 'ollama' | 'claude' | 'openai';
export type TTSEngine = 'xtts' | 'orpheus';

export interface LanguageLearningJobConfig {
  type: 'language-learning';
  projectId: string;
  sourceUrl: string;
  targetLang: string;
  deletedSelectors: string[];

  // AI settings
  aiProvider: AIProvider;
  aiModel: string;

  // Provider-specific settings
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;

  // TTS settings (can use same voice for both, or different)
  sourceVoice: string;          // Voice for source language
  targetVoice: string;          // Voice for target language (can be same)
  ttsEngine: TTSEngine;
  speed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processing Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SentencePair {
  index: number;
  source: string;               // Original sentence (source language)
  target: string;               // Translated sentence (target language)
  sourceTimestamp?: number;     // Start time in seconds
  targetTimestamp?: number;     // Start time of target audio
}

export interface BilingualChapter {
  id: string;
  title: string;
  sentences: SentencePair[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Completed Audiobook
// ─────────────────────────────────────────────────────────────────────────────

export interface CompletedAudiobook {
  id: string;
  title: string;
  path: string;
  duration?: number;            // Duration in seconds
  createdAt: string;
  targetLang?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow State
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowState = 'projects' | 'fetch' | 'select' | 'settings' | 'processing' | 'player';

// ─────────────────────────────────────────────────────────────────────────────
// Analytics Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StageAnalytics {
  name: string;                 // 'fetch', 'cleanup', 'translation', 'source-tts', 'target-tts', 'assembly'
  startedAt?: string;           // ISO timestamp
  completedAt?: string;         // ISO timestamp
  durationMs?: number;          // Duration in milliseconds
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  error?: string;
  // Additional metrics per stage
  metrics?: {
    inputChars?: number;        // Characters processed (cleanup)
    outputChars?: number;       // Characters output
    sentenceCount?: number;     // Number of sentences (translation, TTS)
    batchCount?: number;        // Number of AI batches
    workerCount?: number;       // TTS workers used
    audioFilesGenerated?: number; // TTS audio files
  };
}

export interface ProjectAnalytics {
  projectId: string;
  projectTitle: string;
  createdAt: string;            // When analytics tracking started
  completedAt?: string;         // When the entire workflow completed
  totalDurationMs?: number;     // Total time from start to finish
  status: 'running' | 'completed' | 'error';
  stages: StageAnalytics[];
  // Summary metrics
  summary?: {
    totalSentences?: number;
    sourceAudioDurationMs?: number;
    targetAudioDurationMs?: number;
    finalAudioDurationMs?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Result
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchUrlResult {
  success: boolean;
  htmlPath?: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  content?: string;             // Clean HTML content
  textContent?: string;         // Plain text
  wordCount?: number;
  error?: string;
}
