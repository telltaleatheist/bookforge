/** Shapes returned by the Bookshelf HTTP API (electron/bookshelf-server.ts). */

export interface Audiobook {
  projectId: string;
  title: string;
  author: string;
  type: 'audiobook' | 'bilingual';
  langPair?: string;
  size: number;
  duration?: number;
  downloadPath: string;
  outputFilename?: string;
  coverPath?: string;
  dateAdded?: string;
  tags?: string[];
  source?: 'project' | 'external';
}

export interface Ebook {
  relativePath: string;
  title: string;
  authorFull?: string;
  authorLast?: string;
  authorFirst?: string;
  format: string;
  category?: string;
  tags?: string[];
  fileSize: number;
  year?: number;
  filename?: string;
  dateAdded?: number;
}

export interface Chapter {
  title: string;
  start: number; // seconds
  end: number;   // seconds
}

export interface PdfOutlineItem {
  title: string;
  page: number; // 0-indexed
  depth: number;
}

/** Describes a project's archived book for the in-app reader (/api/read-info). */
export interface ReadInfo {
  format: 'epub' | 'pdf';
  filename: string;
  pages?: number;              // PDF only
  aspect?: number;             // PDF only: first-page width / height
  outline?: PdfOutlineItem[];  // PDF only: chapters
}

export interface QueueJob {
  id: string;
  type: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress: number;
  progressMessage: string | null;
  title: string | null;
  author: string | null;
  epubFilename: string | null;
  error: string | null;
  ttsPhase: string | null;
  ttsConversionProgress: number | null;
  assemblyProgress: number | null;
  assemblySubPhase: string | null;
  estimatedSecondsRemaining: number | null;
  parentJobId: string | null;
  workflowId: string | null;
}

export interface QueueData {
  jobs: QueueJob[];
  isRunning?: boolean;
  currentJobId?: string | null;
}

export interface ReaderSummary {
  id: string;
  name: string;
  hasPin: boolean;
}

export interface AnalyticsBook {
  bookPath: string;
  title: string;
  author: string;
  seconds: number;
  lastAt: string;
}

export interface AnalyticsData {
  reader: { id: string; name: string };
  totalSeconds: number;
  firstAt: string | null;
  lastAt: string | null;
  daily: Record<string, number>; // "YYYY-MM-DD" -> seconds
  books: AnalyticsBook[];
}
