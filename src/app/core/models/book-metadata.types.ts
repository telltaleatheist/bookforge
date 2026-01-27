/**
 * Book metadata for export (shared between PDF and EPUB editors)
 */
export interface BookMetadata {
  title?: string;
  author?: string;
  authorFileAs?: string;  // "Last, First" format for sorting
  year?: string;
  language?: string;
  publisher?: string;
  description?: string;
  coverImage?: string;      // @deprecated - use coverImagePath. Base64 data URL (for old projects)
  coverImagePath?: string;  // Relative path to cover in media folder (e.g., "media/cover_abc123.jpg")
}

/**
 * Chapter marker for EPUB documents
 * Uses sectionIndex instead of page number since EPUBs are section-based
 */
export interface EpubChapter {
  id: string;
  title: string;
  sectionIndex: number;     // Index in the spine/sections array
  sectionHref: string;      // Section href for navigation
  blockId?: string;         // Linked block ID (e.g., "section-0:5")
  y?: number;               // Approximate Y position within section (for ordering)
  level: number;            // 1=chapter, 2=section, 3+=subsection
  source: 'toc' | 'heuristic' | 'manual';
  confidence?: number;      // 0-1 for heuristic detection
}
