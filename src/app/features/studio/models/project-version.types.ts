/**
 * Project Version Types
 *
 * Types for managing different versions of a project's source documents.
 * Books can have multiple versions at different stages of the pipeline:
 * - Original source (PDF/EPUB)
 * - Exported/Finalized EPUB
 * - Cleaned EPUB (after AI cleanup)
 * - Translated EPUBs (per language)
 */

/**
 * Type of version in the pipeline
 */
export type ProjectVersionType =
  | 'original'      // Original PDF/EPUB source file
  | 'finalized'     // Exported EPUB from editor (with all edits)
  | 'cleaned'       // After AI cleanup
  | 'translated';   // After translation to another language

/**
 * A single version of a project's source document
 */
export interface ProjectVersion {
  /** Unique identifier for this version */
  id: string;

  /** Type of version */
  type: ProjectVersionType;

  /** Human-readable label for display */
  label: string;

  /** Description of what this version contains */
  description: string;

  /** Absolute path to the file */
  path: string;

  /** File extension (pdf, epub) */
  extension: string;

  /** Language code (for translated versions) */
  language?: string;

  /** When this version was created/modified */
  modifiedAt?: string;

  /** File size in bytes */
  fileSize?: number;

  /** Whether this version can be edited in the PDF viewer */
  editable: boolean;

  /** Icon to display */
  icon: string;
}

/**
 * Result from getting available versions for a project
 */
export interface ProjectVersionsResult {
  success: boolean;
  error?: string;
  versions?: ProjectVersion[];
}

/**
 * Options for getting project versions
 */
export interface GetProjectVersionsOptions {
  /** Path to the BFP project file */
  bfpPath: string;

  /** Include versions that can't be edited (for display purposes) */
  includeReadOnly?: boolean;
}
