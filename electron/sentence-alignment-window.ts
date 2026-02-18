/**
 * Sentence Alignment Window - Modal popup for verifying/fixing sentence alignment
 *
 * After translation, compares source/target sentence counts.
 * - Mismatch: Blocking modal popup - user must fix alignment
 * - Match + auto-approve OFF: Non-blocking preview
 * - Match + auto-approve ON: Auto-continue (skip popup)
 */

import { BrowserWindow, ipcMain, app } from 'electron';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SentencePair {
  index: number;
  source: string;
  target: string;
}

export interface AlignmentWindowConfig {
  pairs: SentencePair[];
  sourceLang: string;
  targetLang: string;
  blocking: boolean;  // true = mismatch (modal), false = preview (non-modal)
  projectId: string;
  jobId: string;
  autoClose?: boolean;  // true = auto-close after timeout (non-blocking only)
}

export interface AlignmentResult {
  approved: boolean;
  pairs: SentencePair[];  // Possibly modified (deletions)
  cancelled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window State
// ─────────────────────────────────────────────────────────────────────────────

let alignmentWindow: BrowserWindow | null = null;
let alignmentWindowData: AlignmentWindowConfig | null = null;
let alignmentResolve: ((result: AlignmentResult) => void) | null = null;
let autoCloseTimeout: NodeJS.Timeout | null = null;
let userInteracted = false;

// ─────────────────────────────────────────────────────────────────────────────
// Window Manager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the sentence alignment window
 * Returns a promise that resolves when user approves/cancels
 *
 * @param mainWindow - Parent window
 * @param config - Alignment window configuration
 */
export async function openAlignmentWindow(
  mainWindow: BrowserWindow,
  config: AlignmentWindowConfig
): Promise<AlignmentResult> {
  console.log(`[ALIGNMENT] Opening window for project ${config.projectId}, blocking=${config.blocking}`);
  console.log(`[ALIGNMENT] Pairs: ${config.pairs.length} source, checking alignment...`);

  // Store config for IPC access
  alignmentWindowData = config;
  userInteracted = false;

  // If window already exists, reuse it
  if (alignmentWindow && !alignmentWindow.isDestroyed()) {
    alignmentWindow.webContents.send('alignment:update-data', config);
    alignmentWindow.focus();
  } else {
    // Create new window
    alignmentWindow = new BrowserWindow({
      parent: mainWindow,
      modal: config.blocking,
      show: false,
      width: 1000,
      height: 700,
      minWidth: 800,
      minHeight: 500,
      title: config.blocking ? 'Sentence Alignment Required' : 'Sentence Preview',
      alwaysOnTop: config.blocking,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Load the alignment route
    const isDev = !app.isPackaged;
    if (isDev) {
      alignmentWindow.loadURL('http://localhost:4250/#/alignment');
    } else {
      alignmentWindow.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'browser', 'index.html'), {
        hash: '/alignment'
      });
    }

    // Show window when ready
    alignmentWindow.once('ready-to-show', () => {
      alignmentWindow?.show();

      // Bounce dock icon on Mac for blocking (mismatch) case
      if (config.blocking && process.platform === 'darwin') {
        app.dock?.bounce('critical');
      }
    });

    // Handle window close
    alignmentWindow.on('closed', () => {
      console.log('[ALIGNMENT] Window closed');
      alignmentWindow = null;

      // Clear auto-close timeout
      if (autoCloseTimeout) {
        clearTimeout(autoCloseTimeout);
        autoCloseTimeout = null;
      }

      // If no result was sent, treat as cancel
      if (alignmentResolve) {
        alignmentResolve({
          approved: false,
          pairs: alignmentWindowData?.pairs || [],
          cancelled: true
        });
        alignmentResolve = null;
      }

      alignmentWindowData = null;
    });
  }

  // Return promise that resolves on user action
  return new Promise((resolve) => {
    alignmentResolve = resolve;
  });
}

/**
 * Detect if sentence pairs have a mismatch
 */
export function detectMismatch(pairs: SentencePair[]): boolean {
  const sourceCount = pairs.filter(p => p.source.trim()).length;
  const targetCount = pairs.filter(p => p.target.trim()).length;
  return sourceCount !== targetCount;
}

/**
 * Get counts for display
 */
export function getSentenceCounts(pairs: SentencePair[]): { source: number; target: number } {
  return {
    source: pairs.filter(p => p.source.trim()).length,
    target: pairs.filter(p => p.target.trim()).length
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set up IPC handlers for alignment window
 * Should be called once during app initialization
 */
export function setupAlignmentIpc(): void {
  // Get current alignment data
  ipcMain.handle('alignment:get-data', () => {
    return alignmentWindowData;
  });

  // Mark user interaction (prevents auto-close)
  ipcMain.handle('alignment:user-interacted', () => {
    userInteracted = true;
    if (autoCloseTimeout) {
      clearTimeout(autoCloseTimeout);
      autoCloseTimeout = null;
    }
    return { success: true };
  });

  // Save result and close
  ipcMain.handle('alignment:save-result', (_event, result: AlignmentResult) => {
    console.log(`[ALIGNMENT] Result received: approved=${result.approved}, pairs=${result.pairs.length}`);

    if (alignmentResolve) {
      alignmentResolve(result);
      alignmentResolve = null;
    }

    if (alignmentWindow && !alignmentWindow.isDestroyed()) {
      alignmentWindow.close();
    }

    return { success: true };
  });

  // Cancel and close
  ipcMain.handle('alignment:cancel', () => {
    console.log('[ALIGNMENT] Cancel requested');

    if (alignmentResolve) {
      alignmentResolve({
        approved: false,
        pairs: alignmentWindowData?.pairs || [],
        cancelled: true
      });
      alignmentResolve = null;
    }

    if (alignmentWindow && !alignmentWindow.isDestroyed()) {
      alignmentWindow.close();
    }

    return { success: true };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation Flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and potentially align sentences
 * Called after translation completes, before EPUB generation
 *
 * @param mainWindow - Parent window for modal
 * @param pairs - Translated sentence pairs
 * @param sourceLang - Source language code
 * @param targetLang - Target language code
 * @param projectId - Project ID for tracking
 * @param jobId - Current job ID
 * @param autoApprove - If true, auto-continue when counts match (window still shows but non-blocking)
 * @returns Alignment result with potentially modified pairs
 */
export async function validateAndAlignSentences(
  mainWindow: BrowserWindow,
  pairs: SentencePair[],
  sourceLang: string,
  targetLang: string,
  projectId: string,
  jobId: string,
  autoApprove: boolean = true
): Promise<AlignmentResult> {
  const hasMismatch = detectMismatch(pairs);
  const counts = getSentenceCounts(pairs);

  console.log(`[ALIGNMENT] Validating: ${counts.source} source, ${counts.target} target, mismatch=${hasMismatch}, autoApprove=${autoApprove}`);

  // Determine if we should block:
  // - Mismatch: always blocking (user must fix alignment)
  // - Match + autoApprove OFF: blocking (user must click accept)
  // - Match + autoApprove ON: non-blocking (TTS starts, preview stays open)
  const shouldBlock = hasMismatch || !autoApprove;

  const config: AlignmentWindowConfig = {
    pairs,
    sourceLang,
    targetLang,
    blocking: shouldBlock,
    projectId,
    jobId
  };

  if (shouldBlock) {
    // Blocking: wait for user to fix alignment or click accept
    return openAlignmentWindow(mainWindow, config);
  } else {
    // Non-blocking: show preview window, TTS continues immediately
    // Window stays open for user to review
    openAlignmentWindow(mainWindow, config);  // Fire and forget
    return {
      approved: true,
      pairs
    };
  }
}
