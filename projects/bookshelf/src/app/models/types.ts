/** Shapes returned by the Bookshelf HTTP API (electron/bookshelf-server.ts). */

/** One playable audiobook variant of a project (edition/language/format). */
export interface AudiobookVersion {
  variantId: string;
  descriptor?: string;
  type: 'audiobook' | 'bilingual';
  langPair?: string;
  downloadPath: string;
  coverPath?: string;
  size: number;
  duration?: number;
  dateAdded?: string;
  narrationType?: 'professional' | 'tts';
}

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
  // Which version this book resolves to (a specific edition/language/format).
  // Set when a card is built for ONE variant — e.g. the on-device card of a
  // downloaded version, or a version chosen from the download picker — so the
  // shelf can label two downloaded versions of one book distinctly. Absent on a
  // multi-version project card (that carries `versions[]` instead).
  descriptor?: string;
  variantId?: string;
  source?: 'project' | 'external';
  // Narration-source rollups over versions[] — drive the professional/TTS filter.
  hasProfessional?: boolean;
  hasTts?: boolean;
  // Present for project books; > 1 entry means the shelf shows a version picker.
  versions?: AudiobookVersion[];
  // Which server this book came from (multi-server shelf). Stamped client-side
  // after fetch; absent on a single-server / same-origin fetch.
  originServerId?: string;
  // True for a card synthesized from the offline cache. Drives the offline-first
  // playback/cover path; the shelf's on-device section is built from these.
  offline?: boolean;
  // Shelf discriminator (client-side only). A downloaded book whose origin server
  // is ALSO enabled renders TWICE: the on-device copy (`onDevice`) in "On this
  // device" and the server copy (`stream`) in "All audiobooks". `stream` forces
  // streaming — resolveAudioSrc ignores the downloaded cache and hits the HTTP
  // audio endpoint. `onDevice` marks the copy that plays from on-device storage
  // (download or import) and wears the "downloaded" badge.
  stream?: boolean;
  onDevice?: boolean;
}

/** One ebook variant of a project (edition/language/format). */
export interface EbookVersion {
  relativePath: string;
  descriptor?: string;
  format: string;
  title: string;
  authorFull?: string;
  year?: number;
  fileSize: number;
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
  // Present when a project has >1 ebook variant; the shelf pops a picker.
  versions?: EbookVersion[];
  // Project-backed entries carry the owning project id + its type tag; the shelf
  // splits Ebooks vs Articles by projectType and reclassifies by flipping it.
  projectId?: string;
  projectType?: 'book' | 'article';
  // Which server this book came from (multi-server shelf). Stamped client-side
  // after fetch; absent on a single-server / same-origin fetch.
  originServerId?: string;
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
