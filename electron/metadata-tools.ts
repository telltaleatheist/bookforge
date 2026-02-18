/**
 * Unified metadata tool abstraction for audiobook tagging.
 * Uses `tone` on Windows and `m4b-tool` on macOS/Linux.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Tool type detection
type MetadataTool = 'tone' | 'm4b-tool';

interface MetadataToolInfo {
  tool: MetadataTool;
  path: string;
}

/**
 * Get the appropriate metadata tool for the current platform
 */
export function getMetadataToolPath(): MetadataToolInfo | null {
  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === 'win32') {
    // Windows: prefer tone (standalone binary, no PHP required)
    const toneCandidates = [
      path.join(homeDir, 'tools', 'tone', 'tone.exe'),
      'C:\\tools\\tone\\tone.exe',
      'C:\\Program Files\\tone\\tone.exe',
      path.join(homeDir, 'AppData', 'Local', 'tone', 'tone.exe'),
    ];

    for (const candidate of toneCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          return { tool: 'tone', path: candidate };
        }
      } catch { /* continue */ }
    }

    // Fallback: check if m4b-tool exists (requires PHP)
    const m4bCandidates = [
      path.join(homeDir, 'scoop', 'shims', 'm4b-tool.bat'),
      path.join(homeDir, 'scoop', 'apps', 'm4b-tool', 'current', 'm4b-tool.bat'),
      'C:\\Program Files\\m4b-tool\\m4b-tool.bat',
      'C:\\tools\\m4b-tool\\m4b-tool.bat',
    ];

    for (const candidate of m4bCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          return { tool: 'm4b-tool', path: candidate };
        }
      } catch { /* continue */ }
    }

    return null;
  } else {
    // macOS/Linux: prefer m4b-tool (traditional choice)
    const m4bCandidates = [
      '/opt/homebrew/bin/m4b-tool',
      '/usr/local/bin/m4b-tool',
      path.join(homeDir, '.local', 'bin', 'm4b-tool'),
    ];

    for (const candidate of m4bCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          return { tool: 'm4b-tool', path: candidate };
        }
      } catch { /* continue */ }
    }

    // Fallback: check if tone exists
    const toneCandidates = [
      '/usr/local/bin/tone',
      path.join(homeDir, '.local', 'bin', 'tone'),
    ];

    for (const candidate of toneCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          return { tool: 'tone', path: candidate };
        }
      } catch { /* continue */ }
    }

    // Default for Mac (most common installation path)
    return { tool: 'm4b-tool', path: '/opt/homebrew/bin/m4b-tool' };
  }
}

/**
 * Common metadata fields
 */
export interface AudiobookMetadata {
  title?: string;
  author?: string;
  year?: string;
  narrator?: string;
  series?: string;
  seriesNumber?: string;
  genre?: string;
  description?: string;
  coverPath?: string;
  contributors?: Array<{ first: string; last: string }>;
}

/**
 * Remove cover/embedded pictures from an audiobook file
 */
export function removeCover(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const toolInfo = getMetadataToolPath();
    if (!toolInfo) {
      console.log('[METADATA-TOOLS] No metadata tool found, skipping cover removal');
      resolve();
      return;
    }

    let args: string[];

    if (toolInfo.tool === 'tone') {
      // tone: tone tag --meta-remove-property=EmbeddedPictures --force file.m4b
      args = ['tag', '--meta-remove-property=EmbeddedPictures', '--force', filePath];
    } else {
      // NOTE: m4b-tool's --skip-cover doesn't actually REMOVE the cover, it just tells m4b-tool
      // not to copy the existing cover during metadata operations. For proper cover replacement,
      // we rely on applyMetadata() with --cover which should replace the existing cover.
      // This call is mainly a no-op for m4b-tool but left for compatibility.
      args = ['meta', '--skip-cover', '-f', filePath];
    }

    console.log(`[METADATA-TOOLS] Removing cover: ${toolInfo.path} ${args.join(' ')}`);

    const proc = spawn(toolInfo.path, args, {
      shell: os.platform() === 'win32' && toolInfo.tool === 'm4b-tool'
    });

    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      console.log('[METADATA-TOOLS]', data.toString().trim());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[METADATA-TOOLS STDERR]', data.toString().trim());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Cover removal failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Apply metadata to an audiobook file
 */
export function applyMetadata(filePath: string, metadata: AudiobookMetadata): Promise<void> {
  return new Promise((resolve, reject) => {
    const toolInfo = getMetadataToolPath();
    if (!toolInfo) {
      console.log('[METADATA-TOOLS] No metadata tool found, skipping metadata application');
      resolve();
      return;
    }

    // Build artist string from contributors if available
    const artistString = metadata.contributors && metadata.contributors.length > 0
      ? metadata.contributors
          .filter(c => c.first || c.last)
          .map(c => [c.first, c.last].filter(Boolean).join(' '))
          .join('; ')
      : metadata.author;

    let args: string[];

    if (toolInfo.tool === 'tone') {
      // Build tone arguments
      args = ['tag'];

      if (metadata.title) {
        args.push('--meta-title', metadata.title);
      }
      if (artistString) {
        args.push('--meta-artist', artistString);
      }
      if (metadata.year) {
        // tone requires full date format (YYYY-MM-DD), convert year-only to full date
        const yearValue = metadata.year.includes('-') ? metadata.year : `${metadata.year}-01-01`;
        args.push('--meta-publishing-date', yearValue);
      }
      if (metadata.narrator) {
        args.push('--meta-narrator', metadata.narrator);
      }
      if (metadata.series) {
        args.push('--meta-group', metadata.series);
      }
      if (metadata.genre) {
        args.push('--meta-genre', metadata.genre);
      }
      if (metadata.description) {
        args.push('--meta-description', metadata.description);
      }
      if (metadata.coverPath && fs.existsSync(metadata.coverPath)) {
        args.push('--meta-cover-file', metadata.coverPath);
      }

      args.push('--force', filePath);
    } else {
      // Build m4b-tool arguments
      args = ['meta'];

      if (metadata.title) {
        args.push('--name', metadata.title);
      }
      if (artistString) {
        args.push('--artist', artistString);
      }
      if (metadata.year) {
        args.push('--year', metadata.year);
      }
      if (metadata.narrator) {
        // m4b-tool uses --writer for narrator (based on common usage)
        args.push('--writer', metadata.narrator);
      }
      if (metadata.series) {
        args.push('--series', metadata.series);
      }
      if (metadata.seriesNumber) {
        args.push('--series-part', metadata.seriesNumber);
      }
      if (metadata.genre) {
        args.push('--genre', metadata.genre);
      }
      if (metadata.description) {
        args.push('--description', metadata.description);
      }
      if (metadata.coverPath && fs.existsSync(metadata.coverPath)) {
        args.push('--cover', metadata.coverPath);
      }

      args.push('-f', filePath);
    }

    // Check if we have any metadata to apply (beyond just the force flag and file path)
    const minArgs = toolInfo.tool === 'tone' ? 3 : 3; // tag + --force + file OR meta + -f + file
    if (args.length <= minArgs) {
      console.log('[METADATA-TOOLS] No metadata to apply');
      resolve();
      return;
    }

    console.log(`[METADATA-TOOLS] Applying metadata: ${toolInfo.path} ${args.join(' ')}`);

    const proc = spawn(toolInfo.path, args, {
      shell: os.platform() === 'win32' && toolInfo.tool === 'm4b-tool'
    });

    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      console.log('[METADATA-TOOLS]', data.toString().trim());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[METADATA-TOOLS STDERR]', data.toString().trim());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Metadata application failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Check if a metadata tool is available
 */
export function isMetadataToolAvailable(): boolean {
  return getMetadataToolPath() !== null;
}

/**
 * Get the name of the available metadata tool
 */
export function getMetadataToolName(): string | null {
  const toolInfo = getMetadataToolPath();
  return toolInfo?.tool || null;
}
