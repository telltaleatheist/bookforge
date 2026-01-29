/**
 * Audiobook Project Types
 *
 * Each audiobook is a self-contained project folder with:
 * - exported.epub: The source EPUB file
 * - exported_cleaned.epub or cleaned.epub: AI-cleaned version (optional)
 * - project.json: Metadata, settings, and state
 * - output.m4b: Final audiobook (when complete)
 */

export interface AudiobookProject {
  id: string;                    // Folder name / unique identifier
  folderPath: string;            // Full path to project folder

  // Source file info
  originalFilename: string;      // Original EPUB filename before import
  hasOriginal: boolean;          // exported.epub exists
  hasCleaned: boolean;           // cleaned epub exists (exported_cleaned.epub or cleaned.epub)
  cleanedFilename?: string;      // Filename of cleaned epub if it exists
  hasOutput: boolean;            // output.m4b exists

  // Metadata (from EPUB or edited by user)
  metadata: AudiobookMetadata;

  // State
  state: AudiobookState;

  // Timestamps
  createdAt: string;
  modifiedAt: string;
}

export interface AudiobookMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFirstName?: string;
  authorLastName?: string;
  year?: string;
  language: string;
  coverPath?: string;            // Path to cover image within project folder
  outputFilename?: string;       // Custom output filename
}

export interface AudiobookState {
  // Cleanup state
  cleanupStatus: 'none' | 'pending' | 'processing' | 'complete' | 'error';
  cleanupProgress?: number;      // 0-100
  cleanupError?: string;
  cleanupJobId?: string;         // Reference to queue job

  // TTS state
  ttsStatus: 'none' | 'pending' | 'processing' | 'complete' | 'error';
  ttsProgress?: number;          // 0-100
  ttsError?: string;
  ttsJobId?: string;             // Reference to queue job

  // TTS settings (saved per-project)
  ttsSettings?: TTSSettings;
}

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  voice: string;
  temperature: number;
  speed: number;
}

/**
 * Project JSON file structure (saved as project.json)
 */
export interface AudiobookProjectFile {
  version: number;
  originalFilename: string;
  metadata: AudiobookMetadata;
  state: AudiobookState;
  createdAt: string;
  modifiedAt: string;
}

/**
 * Result when listing projects
 */
export interface AudiobookProjectInfo {
  id: string;
  folderPath: string;
  metadata: AudiobookMetadata;
  hasOriginal: boolean;
  hasCleaned: boolean;
  cleanedFilename?: string;      // Filename of cleaned epub if it exists
  hasOutput: boolean;
  state: AudiobookState;
  createdAt: string;
  modifiedAt: string;
}
