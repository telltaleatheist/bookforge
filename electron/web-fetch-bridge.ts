/**
 * Web Fetch Bridge - Article extraction for Language Learning feature
 *
 * Uses Mozilla Readability to extract clean article content from web pages.
 * This automatically removes ads, navigation, and other junk - no manual
 * block selection needed.
 */

import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchUrlResult {
  success: boolean;
  pdfPath?: string;
  htmlPath?: string;
  title?: string;
  byline?: string;        // Author info
  excerpt?: string;       // Article summary
  textContent?: string;   // Plain text content
  content?: string;       // HTML content (cleaned)
  wordCount?: number;
  error?: string;
}

export interface LanguageLearningProject {
  id: string;
  sourceUrl: string;
  title: string;
  byline?: string;              // Author info from Readability
  excerpt?: string;             // Article summary
  wordCount?: number;           // Word count
  content?: string;             // HTML content (cleaned)
  sourceLang: string;           // 'en' (auto-detected or manual)
  targetLang: string;           // 'de', 'es', 'fr', etc. (user selected)
  status: 'fetched' | 'selected' | 'processing' | 'completed' | 'error';

  // File paths
  htmlPath: string;             // Clean article HTML from Readability
  textContent?: string;         // Plain text content (cached)
  deletedSelectors: string[];   // CSS selectors for elements user removed

  // Outputs
  bilingualEpubPath?: string;
  audiobookPath?: string;
  vttPath?: string;

  // Timestamps
  createdAt: string;
  modifiedAt: string;
}

export interface LanguageLearningJobConfig {
  type: 'language-learning';
  projectId: string;
  sourceUrl: string;
  targetLang: string;
  deletedSelectors: string[];

  // AI settings
  aiProvider: 'ollama' | 'claude' | 'openai';
  aiModel: string;

  // TTS settings (can use same voice for both, or different)
  sourceVoice: string;          // Voice for source language
  targetVoice: string;          // Voice for target language (can be same)
  ttsEngine: 'xtts' | 'orpheus';
  speed: number;
}

// Supported target languages
export const SUPPORTED_LANGUAGES = [
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
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// URL to PDF Conversion
// ─────────────────────────────────────────────────────────────────────────────

// Cache the Readability library source
let readabilitySource: string | null = null;

/**
 * Load the Mozilla Readability library source code
 */
async function loadReadabilityLibrary(): Promise<string> {
  if (readabilitySource) {
    return readabilitySource;
  }

  // Try multiple paths for Readability.js
  const possiblePaths = [
    // Development: from project root
    path.join(__dirname, '..', '..', 'node_modules', '@mozilla', 'readability', 'Readability.js'),
    // Production: from app resources
    path.join(app.getAppPath(), 'node_modules', '@mozilla', 'readability', 'Readability.js'),
    // Alternative: from dist folder
    path.join(__dirname, '..', 'node_modules', '@mozilla', 'readability', 'Readability.js'),
  ];

  for (const libPath of possiblePaths) {
    try {
      readabilitySource = await fs.readFile(libPath, 'utf-8');
      console.log('[WEB-FETCH] Loaded Readability from:', libPath);
      return readabilitySource;
    } catch {
      // Try next path
    }
  }

  throw new Error('Could not find Readability.js library');
}

/**
 * Build the extraction script that uses Mozilla Readability
 */
function buildExtractionScript(readabilityLib: string): string {
  return `
    (function() {
      // Inject Readability library
      ${readabilityLib}

      // Run extraction
      try {
        // Debug: check what we have
        const bodyText = document.body ? document.body.textContent.substring(0, 500) : 'NO BODY';
        const paragraphs = document.querySelectorAll('p').length;
        const articles = document.querySelectorAll('article').length;
        console.log('[Readability] Body preview:', bodyText);
        console.log('[Readability] Paragraphs:', paragraphs, 'Articles:', articles);

        const documentClone = document.cloneNode(true);
        const reader = new Readability(documentClone);
        const article = reader.parse();

        if (article) {
          return {
            title: article.title || 'Untitled',
            byline: article.byline || '',
            excerpt: article.excerpt || '',
            content: article.content || '',
            textContent: article.textContent || '',
            length: (article.textContent || '').length,
            siteName: article.siteName || ''
          };
        } else {
          // Return debug info when Readability fails
          return {
            error: 'Readability could not parse article',
            length: 0,
            debug: {
              bodyLength: document.body ? document.body.textContent.length : 0,
              paragraphs: paragraphs,
              articles: articles,
              title: document.title,
              preview: bodyText
            }
          };
        }
      } catch (err) {
        return { error: err.message || 'Unknown error', length: 0 };
      }
    })();
  `;
}

/**
 * Fetch a URL and extract article content using Readability
 * @param url The URL to fetch
 * @param libraryRoot The library root path
 * @param providedProjectId Optional projectId - if not provided, one will be generated
 */
export async function fetchUrlToPdf(
  url: string,
  libraryRoot: string,
  providedProjectId?: string
): Promise<FetchUrlResult & { projectId?: string }> {
  console.log('[WEB-FETCH] Starting URL fetch:', url);

  // Use a persistent session so cookies (including captcha solutions) persist
  const { session } = require('electron');
  const fetchSession = session.fromPartition('persist:web-fetch');

  // Track if window was manually closed
  let windowClosed = false;
  let closeReject: ((err: Error) => void) | null = null;

  // Create browser window - hidden by default, only shown for captcha
  const fetchWindow = new BrowserWindow({
    show: false,  // Hidden until captcha detected
    width: 1200,
    height: 800,
    title: 'Loading article...',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      images: true,
      session: fetchSession,
      // Make it look more like a real browser
      webgl: true,
      plugins: true,
    },
  });

  // Set a realistic user agent
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  fetchWindow.webContents.setUserAgent(userAgent);

  // Set extra headers to look more legitimate
  fetchWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
    details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    details.requestHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    details.requestHeaders['Sec-Ch-Ua'] = '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"';
    details.requestHeaders['Sec-Ch-Ua-Mobile'] = '?0';
    details.requestHeaders['Sec-Ch-Ua-Platform'] = '"macOS"';
    details.requestHeaders['Sec-Fetch-Dest'] = 'document';
    details.requestHeaders['Sec-Fetch-Mode'] = 'navigate';
    details.requestHeaders['Sec-Fetch-Site'] = 'none';
    details.requestHeaders['Sec-Fetch-User'] = '?1';
    details.requestHeaders['Upgrade-Insecure-Requests'] = '1';
    callback({ requestHeaders: details.requestHeaders });
  });

  // Handle window being closed manually by user
  fetchWindow.on('closed', () => {
    windowClosed = true;
    console.log('[WEB-FETCH] Window closed by user');
    if (closeReject) {
      closeReject(new Error('Window closed by user'));
    }
  });

  // Helper to check if window is still valid
  const isWindowValid = (): boolean => {
    return !windowClosed && !fetchWindow.isDestroyed();
  };

  // Helper to safely execute JavaScript
  const safeExecuteJS = async <T>(script: string): Promise<T> => {
    if (!isWindowValid()) {
      throw new Error('Window closed by user');
    }
    return fetchWindow.webContents.executeJavaScript(script);
  };

  try {
    // Load the URL
    console.log('[WEB-FETCH] Loading URL...');

    // Use a more robust loading strategy
    const loadPromise = fetchWindow.loadURL(url);

    // Wait for initial load with timeout
    const loadTimeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Initial load timeout (60s)')), 60000);
    });

    try {
      await Promise.race([loadPromise, loadTimeout]);
    } catch (err) {
      // If loadURL itself times out, we might still have partial content
      console.warn('[WEB-FETCH] Load warning:', (err as Error).message);
    }

    // Wait for dom-ready (more reliable than did-finish-load for complex sites)
    await new Promise<void>((resolve, reject) => {
      // Store reject for window close handler
      closeReject = reject;

      try {
        if (!isWindowValid()) {
          closeReject = null;
          reject(new Error('Window closed by user'));
          return;
        }

        // Safely check if still loading
        let isLoading = false;
        try {
          isLoading = fetchWindow.webContents.isLoading();
        } catch {
          closeReject = null;
          reject(new Error('Window closed by user'));
          return;
        }

        if (isLoading) {
          // Wait for stop-loading or timeout
          const stopTimeout = setTimeout(() => {
            console.log('[WEB-FETCH] Proceeding after content timeout');
            closeReject = null;
            resolve();
          }, 10000);

          fetchWindow.webContents.once('did-stop-loading', () => {
            clearTimeout(stopTimeout);
            console.log('[WEB-FETCH] Page stopped loading');
            closeReject = null;
            resolve();
          });
        } else {
          closeReject = null;
          resolve();
        }
      } catch (err) {
        closeReject = null;
        reject(new Error('Window closed by user'));
      }
    });

    // Check if window was closed during loading
    if (!isWindowValid()) {
      return { success: false, error: 'Window closed by user' };
    }

    // Check for captcha - if detected, wait for user to solve it
    const checkForCaptcha = async (): Promise<boolean> => {
      if (!isWindowValid()) return false;
      const pageContent = await safeExecuteJS<string>(`
        document.body ? document.body.textContent.substring(0, 1000) : ''
      `);
      return pageContent.includes('captcha-delivery') ||
             pageContent.includes('challenge') ||
             pageContent.includes('verify you are human') ||
             pageContent.length < 500;
    };

    // Initial wait
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!isWindowValid()) {
      return { success: false, error: 'Window closed by user' };
    }

    // Check for captcha and wait if needed
    let hasCaptcha = await checkForCaptcha();
    if (hasCaptcha && isWindowValid()) {
      console.log('[WEB-FETCH] Captcha detected! Showing window for user to solve...');
      fetchWindow.setTitle('Please solve the captcha, then close this window');
      fetchWindow.show();  // Show the hidden window
      fetchWindow.focus();

      // Wait up to 60 seconds for captcha to be solved
      const captchaTimeout = 60000;
      const checkInterval = 2000;
      const startTime = Date.now();

      while (hasCaptcha && isWindowValid() && (Date.now() - startTime) < captchaTimeout) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));

        if (!isWindowValid()) break;

        // Check if content has changed (captcha solved)
        const bodyLength = await safeExecuteJS<number>(
          'document.body ? document.body.textContent.length : 0'
        );
        console.log('[WEB-FETCH] Checking... body length:', bodyLength);

        if (bodyLength > 1000) {
          hasCaptcha = false;
          console.log('[WEB-FETCH] Captcha appears to be solved!');
        }
      }

      if (hasCaptcha && isWindowValid()) {
        console.log('[WEB-FETCH] Captcha timeout - proceeding anyway');
      }
    }

    // Check if window was closed during captcha waiting
    if (!isWindowValid()) {
      return { success: false, error: 'Window closed by user' };
    }

    // Give additional time for JS-rendered content
    console.log('[WEB-FETCH] Waiting for dynamic content (3s)...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (!isWindowValid()) {
      return { success: false, error: 'Window closed by user' };
    }

    // Load Readability library and build extraction script
    console.log('[WEB-FETCH] Loading Readability library...');
    const readabilityLib = await loadReadabilityLibrary();
    const extractionScript = buildExtractionScript(readabilityLib);

    // Extract article using Mozilla Readability
    console.log('[WEB-FETCH] Extracting article content with Readability...');
    const article = await safeExecuteJS<{
      title: string;
      byline: string;
      excerpt: string;
      content: string;
      textContent: string;
      length: number;
      error?: string;
      debug?: {
        bodyLength: number;
        paragraphs: number;
        articles: number;
        title: string;
        preview: string;
      };
    } | null>(extractionScript);

    // Also get the full HTML for reference
    const fullHtml = await safeExecuteJS<string>(
      'document.documentElement.outerHTML'
    );

    // Clean up window if still valid
    if (isWindowValid()) {
      fetchWindow.destroy();
    }

    if (!article) {
      return {
        success: false,
        error: 'Article extraction returned null.',
      };
    }

    if (article.error) {
      // Log debug info to help diagnose the issue
      if (article.debug) {
        console.log('[WEB-FETCH] Debug info:', JSON.stringify(article.debug, null, 2));
      }
      return {
        success: false,
        error: `Readability error: ${article.error}. Debug: bodyLength=${article.debug?.bodyLength}, paragraphs=${article.debug?.paragraphs}, articles=${article.debug?.articles}`,
      };
    }

    if (!article.content || article.length < 100) {
      return {
        success: false,
        error: `Could not extract article content. Text length: ${article.length}. The page may not contain a readable article.`,
      };
    }

    console.log('[WEB-FETCH] Article extracted:', {
      title: article.title,
      byline: article.byline,
      length: article.textContent?.length,
      excerpt: article.excerpt?.substring(0, 100) + '...',
    });

    // Use provided projectId or generate a new one
    const projectId = providedProjectId || crypto.randomBytes(8).toString('hex');
    console.log('[WEB-FETCH] Using projectId:', projectId);

    // Create project directory
    const projectDir = path.join(libraryRoot, 'language-learning', 'projects', projectId);
    await fs.mkdir(projectDir, { recursive: true });

    // Save original HTML file (for reference)
    const htmlPath = path.join(projectDir, 'source.html');
    await fs.writeFile(htmlPath, fullHtml, 'utf-8');
    console.log('[WEB-FETCH] Original HTML saved to:', htmlPath);

    // Save extracted article content
    const articlePath = path.join(projectDir, 'article.json');
    await fs.writeFile(articlePath, JSON.stringify({
      title: article.title,
      byline: article.byline,
      excerpt: article.excerpt,
      content: article.content,       // Clean HTML
      textContent: article.textContent, // Plain text
      length: article.length,
      url: url,
      extractedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
    console.log('[WEB-FETCH] Article JSON saved to:', articlePath);

    // Save clean HTML for viewing
    const cleanHtmlPath = path.join(projectDir, 'article.html');
    const cleanHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(article.title || 'Article')}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 2em; margin-bottom: 0.5em; }
    .byline { color: #666; font-style: italic; margin-bottom: 2em; }
    p { margin: 1em 0; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>${escapeHtml(article.title || 'Article')}</h1>
  ${article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : ''}
  ${article.content}
</body>
</html>`;
    await fs.writeFile(cleanHtmlPath, cleanHtml, 'utf-8');
    console.log('[WEB-FETCH] Clean HTML saved to:', cleanHtmlPath);

    // Count words
    const wordCount = article.textContent?.split(/\s+/).filter(w => w.length > 0).length || 0;

    return {
      success: true,
      projectId,  // Return the projectId so caller can use the same one
      htmlPath: cleanHtmlPath,  // Point to clean HTML, not original
      title: article.title || 'Untitled',
      byline: article.byline || undefined,
      excerpt: article.excerpt || undefined,
      textContent: article.textContent || undefined,
      content: article.content || undefined,
      wordCount,
    };
  } catch (error) {
    console.error('[WEB-FETCH] Error:', error);
    try {
      fetchWindow.destroy();
    } catch {
      // Window might already be destroyed
    }

    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Project Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a language learning project to disk
 */
export async function saveProject(
  project: LanguageLearningProject,
  libraryRoot: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const projectDir = path.join(libraryRoot, 'language-learning', 'projects', project.id);
    await fs.mkdir(projectDir, { recursive: true });

    const projectPath = path.join(projectDir, 'project.json');
    project.modifiedAt = new Date().toISOString();

    await fs.writeFile(projectPath, JSON.stringify(project, null, 2), 'utf-8');
    console.log('[WEB-FETCH] Project saved:', projectPath);

    return { success: true };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to save project:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Update specific fields of a language learning project
 * Loads the existing project, merges updates, and saves it back
 */
export async function updateProject(
  projectId: string,
  updates: Partial<LanguageLearningProject>,
  libraryRoot: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const projectPath = path.join(
      libraryRoot,
      'language-learning',
      'projects',
      projectId,
      'project.json'
    );

    // Load existing project
    const content = await fs.readFile(projectPath, 'utf-8');
    const project = JSON.parse(content) as LanguageLearningProject;

    // Merge updates
    const updatedProject = {
      ...project,
      ...updates,
      modifiedAt: new Date().toISOString()
    };

    // Save back
    await fs.writeFile(projectPath, JSON.stringify(updatedProject, null, 2), 'utf-8');
    console.log('[WEB-FETCH] Project updated:', projectPath, updates);

    return { success: true };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to update project:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Load a language learning project from disk
 */
export async function loadProject(
  projectId: string,
  libraryRoot: string
): Promise<{ success: boolean; project?: LanguageLearningProject; error?: string }> {
  try {
    const projectPath = path.join(
      libraryRoot,
      'language-learning',
      'projects',
      projectId,
      'project.json'
    );

    const content = await fs.readFile(projectPath, 'utf-8');
    const project = JSON.parse(content) as LanguageLearningProject;

    return { success: true, project };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to load project:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * List all language learning projects
 */
export async function listProjects(
  libraryRoot: string
): Promise<{ success: boolean; projects?: LanguageLearningProject[]; error?: string }> {
  try {
    const projectsDir = path.join(libraryRoot, 'language-learning', 'projects');

    // Ensure directory exists
    try {
      await fs.access(projectsDir);
    } catch {
      // Directory doesn't exist, return empty list
      return { success: true, projects: [] };
    }

    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projects: LanguageLearningProject[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectPath = path.join(projectsDir, entry.name, 'project.json');
        try {
          const content = await fs.readFile(projectPath, 'utf-8');
          const project = JSON.parse(content) as LanguageLearningProject;
          projects.push(project);
        } catch {
          // Skip invalid project directories
          console.warn('[WEB-FETCH] Skipping invalid project:', entry.name);
        }
      }
    }

    // Sort by modified date, newest first
    projects.sort((a, b) => {
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    return { success: true, projects };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to list projects:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Delete a language learning project and its associated audiobook files
 */
export async function deleteProject(
  projectId: string,
  libraryRoot: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Delete project directory
    const projectDir = path.join(libraryRoot, 'language-learning', 'projects', projectId);
    await fs.rm(projectDir, { recursive: true, force: true });
    console.log('[WEB-FETCH] Project deleted:', projectDir);

    // Delete associated audiobook files
    const audiobooksDir = path.join(libraryRoot, 'language-learning', 'audiobooks');
    const audioExtensions = ['.m4b', '.vtt', '.flac', '.mp3'];

    for (const ext of audioExtensions) {
      const filePath = path.join(audiobooksDir, `${projectId}${ext}`);
      try {
        await fs.rm(filePath, { force: true });
        console.log('[WEB-FETCH] Audiobook file deleted:', filePath);
      } catch {
        // File doesn't exist, ignore
      }
    }

    return { success: true };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to delete project:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDirectory(
  dirPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return { success: true };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to ensure directory:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Delete existing audiobook files for a project (called before re-running TTS)
 */
export async function deleteProjectAudiobooks(
  projectId: string,
  libraryRoot: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const audiobooksDir = path.join(libraryRoot, 'language-learning', 'audiobooks');
    const audioExtensions = ['.m4b', '.vtt', '.flac', '.mp3'];

    for (const ext of audioExtensions) {
      // Direct file in audiobooks folder
      const filePath = path.join(audiobooksDir, `${projectId}${ext}`);
      try {
        await fs.rm(filePath, { force: true });
        console.log('[WEB-FETCH] Deleted audiobook file:', filePath);
      } catch {
        // File doesn't exist, ignore
      }

      // VTT in subfolder
      if (ext === '.vtt') {
        const vttPath = path.join(audiobooksDir, 'vtt', `${projectId}${ext}`);
        try {
          await fs.rm(vttPath, { force: true });
          console.log('[WEB-FETCH] Deleted VTT file:', vttPath);
        } catch {
          // File doesn't exist, ignore
        }
      }
    }

    return { success: true };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to delete audiobooks:', error);
    return { success: false, error: (error as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Completed Audiobooks
// ─────────────────────────────────────────────────────────────────────────────

export interface CompletedAudiobook {
  id: string;
  title: string;
  path: string;
  duration?: number;
  createdAt: string;
  sourceLang?: string;
  targetLang?: string;
}

/**
 * List completed bilingual audiobooks
 * Enriches audiobook data with project metadata (title, languages)
 */
export async function listCompletedAudiobooks(
  libraryRoot: string
): Promise<{ success: boolean; audiobooks?: CompletedAudiobook[]; error?: string }> {
  try {
    const audiobooksDir = path.join(libraryRoot, 'language-learning', 'audiobooks');
    const projectsDir = path.join(libraryRoot, 'language-learning', 'projects');

    // Ensure directory exists
    try {
      await fs.access(audiobooksDir);
    } catch {
      return { success: true, audiobooks: [] };
    }

    const entries = await fs.readdir(audiobooksDir, { withFileTypes: true });
    const audiobooks: CompletedAudiobook[] = [];

    for (const entry of entries) {
      // Skip macOS metadata files (AppleDouble files starting with ._)
      if (entry.name.startsWith('._')) continue;

      if (entry.isFile() && entry.name.endsWith('.m4b')) {
        const filePath = path.join(audiobooksDir, entry.name);
        const stats = await fs.stat(filePath);
        const projectId = path.basename(entry.name, '.m4b');

        // Try to load project metadata for enrichment
        let title = projectId;
        let sourceLang: string | undefined;
        let targetLang: string | undefined;

        try {
          const projectJsonPath = path.join(projectsDir, projectId, 'project.json');
          const projectData = await fs.readFile(projectJsonPath, 'utf-8');
          const project = JSON.parse(projectData);

          if (project.title) {
            title = project.title;
          }
          if (project.sourceLang) {
            sourceLang = project.sourceLang;
          }
          if (project.targetLang) {
            targetLang = project.targetLang;
          }
        } catch {
          // Project metadata not found, use defaults
          console.log(`[WEB-FETCH] No project metadata found for ${projectId}`);
        }

        audiobooks.push({
          id: projectId,
          title,
          path: filePath,
          createdAt: stats.mtime.toISOString(),
          sourceLang,
          targetLang,
        });
      }
    }

    // Sort by creation date, newest first
    audiobooks.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return { success: true, audiobooks };
  } catch (error) {
    console.error('[WEB-FETCH] Failed to list audiobooks:', error);
    return { success: false, error: (error as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Extraction from HTML
// ─────────────────────────────────────────────────────────────────────────────

// Patterns for boilerplate content that should be filtered out
const BOILERPLATE_PATTERNS = [
  // Newsletter signups
  /\b(sign up|subscribe|newsletter|get our|join our)\b.*?(here|now|today|free)/i,
  /\b(enter your email|your email address)\b/i,
  // Social media
  /\b(follow us on|share this|tweet this|like us on)\b/i,
  // Image captions that got merged (e.g., "Shows food cost changes")
  /^shows?\s+\w+\s+(cost|price|rate|change|trend)/i,
  // Read more / related
  /\b(read more|related articles?|see also|more from)\b:?\s*$/i,
  // Copyright / legal
  /\b(all rights reserved|copyright|©)\b/i,
  /\bour standards:?\s*(the\s+)?thomson reuters/i,
];

/**
 * Check if text is likely boilerplate content
 */
function isBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 5) return true;  // Too short
  if (trimmed.length > 500) return false;  // Long paragraphs are likely content

  return BOILERPLATE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Extract clean text from saved HTML file
 * Preserves paragraph structure for proper sentence splitting
 *
 * Uses a proper DOM tree traversal to extract text only from "leaf" block elements -
 * elements that contain text but don't have nested block-level children.
 * This prevents duplication that occurs when extracting textContent from container divs.
 *
 * @param htmlPath - Path to the HTML file
 * @param deletedSelectors - CSS selectors for elements to remove (from user selection)
 */
export async function extractTextFromHtml(
  htmlPath: string,
  deletedSelectors: string[]
): Promise<{ success: boolean; text?: string; error?: string }> {
  const html = await fs.readFile(htmlPath, 'utf-8');

  // Use Electron's BrowserWindow for proper DOM parsing
  const { BrowserWindow } = require('electron');

  const parseWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  try {
    await parseWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Extract text using proper DOM tree traversal
    const extractedText = await parseWindow.webContents.executeJavaScript(`
      (function() {
        // Step 1: Remove user-deleted elements
        // IMPORTANT: Collect all elements FIRST before removing any, because
        // nth-of-type selectors use indices that shift when elements are removed
        const selectors = ${JSON.stringify(deletedSelectors)};
        const elementsToRemove = new Set();
        for (const selector of selectors) {
          try {
            document.querySelectorAll(selector).forEach(el => elementsToRemove.add(el));
          } catch (e) {
            console.warn('Invalid selector:', selector);
          }
        }
        // Now remove all collected elements
        elementsToRemove.forEach(el => el.remove());
        console.log('Removed', elementsToRemove.size, 'elements from', selectors.length, 'selectors');

        // Step 2: Remove non-content elements
        const removeSelectors = [
          'script', 'style', 'noscript', 'nav', 'aside',
          '[data-testid="promo-box"]',
          '[class*="newsletter"]',
          '[class*="signup"]',
          '[class*="social-share"]',
          '[aria-label="Tags"]'
        ];
        removeSelectors.forEach(sel => {
          try {
            document.querySelectorAll(sel).forEach(el => el.remove());
          } catch (e) {}
        });

        // Step 3: Extract text using tree traversal
        // Only extract from "leaf" block elements (blocks without nested blocks)
        const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH']);
        const CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD']);
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'ASIDE', 'FIGURE', 'IFRAME', 'SVG']);

        const paragraphs = [];

        // Check if element has any block-level children
        function hasBlockChildren(element) {
          for (const child of element.children) {
            if (BLOCK_TAGS.has(child.tagName) || CONTAINER_TAGS.has(child.tagName)) {
              return true;
            }
          }
          return false;
        }

        // Recursively extract text from DOM tree
        function extractFromElement(element) {
          if (!element || SKIP_TAGS.has(element.tagName)) return;

          if (BLOCK_TAGS.has(element.tagName)) {
            // This is a block element - check if it's a leaf (no nested blocks)
            if (!hasBlockChildren(element)) {
              const text = element.textContent.trim();
              if (text.length > 0) {
                paragraphs.push(text);
              }
            } else {
              // Has block children - recurse into them instead
              for (const child of element.children) {
                extractFromElement(child);
              }
            }
          } else if (CONTAINER_TAGS.has(element.tagName)) {
            // Container element - recurse into children
            for (const child of element.children) {
              extractFromElement(child);
            }
          } else {
            // Other elements (spans, etc) - recurse
            for (const child of element.children) {
              extractFromElement(child);
            }
          }
        }

        // Start extraction from body
        if (document.body) {
          extractFromElement(document.body);
        }

        // Fallback: if we got nothing, try getting body text directly
        if (paragraphs.length === 0 && document.body) {
          const bodyText = document.body.textContent.trim();
          if (bodyText) {
            paragraphs.push(bodyText);
          }
        }

        return paragraphs.join('\\n\\n');
      })();
    `);

    parseWindow.destroy();

    // Post-process: normalize whitespace and filter boilerplate
    const paragraphs = extractedText
      .split(/\n\n+/)
      .map((para: string) => para.replace(/\s+/g, ' ').trim())
      .filter((para: string) => para.length > 0)
      .filter((para: string) => !isBoilerplate(para));

    const text = paragraphs.join('\n\n');
    console.log(`[WEB-FETCH] Extracted ${text.length} chars, ${paragraphs.length} paragraphs (removed ${deletedSelectors.length} user selections)`);

    return { success: true, text };
  } catch (error) {
    parseWindow.destroy();
    console.error('[WEB-FETCH] Failed to extract text:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
