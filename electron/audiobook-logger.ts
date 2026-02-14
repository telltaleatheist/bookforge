/**
 * Audiobook Conversion Logger
 *
 * Centralized logging system for tracking audiobook conversion jobs,
 * errors, and performance metrics. Creates daily log files for easy
 * morning review.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  jobId: string;
  bookTitle?: string;
  author?: string;
  phase?: string;
  message: string;
  details?: any;
  error?: {
    message: string;
    stack?: string;
    code?: number;
  };
}

export interface JobSummary {
  jobId: string;
  bookTitle: string;
  author: string;
  startTime: string;
  endTime?: string;
  duration?: number; // seconds
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  totalChapters?: number;
  totalSentences?: number;
  flacFilesCreated?: number;
  outputPath?: string;
  error?: string;
  settings?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

let logsPath = '';
let currentLogFile = '';
let jobSummaries = new Map<string, JobSummary>();

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

export async function initializeLogger(libraryPath: string): Promise<void> {
  logsPath = path.join(libraryPath, 'logs');

  // Ensure logs directory exists
  await fs.mkdir(logsPath, { recursive: true });

  // Set current log file based on today's date
  const today = new Date().toISOString().split('T')[0];
  currentLogFile = path.join(logsPath, `audiobook-${today}.log`);

  // Load existing summaries from today's log if it exists
  await loadExistingSummaries();

  // Write initialization message
  await writeLog({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    jobId: 'system',
    message: 'Audiobook logger initialized',
    details: { logsPath, currentLogFile }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Logging Functions
// ─────────────────────────────────────────────────────────────────────────────

async function writeLog(entry: LogEntry): Promise<void> {
  const logLine = JSON.stringify(entry) + '\n';

  try {
    await fs.appendFile(currentLogFile, logLine, 'utf8');
  } catch (error) {
    // If we can't write to the log, at least log to console
    console.error('Failed to write to log file:', error);
    console.log('Log entry:', entry);
  }
}

export async function log(
  level: LogLevel,
  jobId: string,
  message: string,
  details?: any
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    jobId,
    message,
    details
  };

  // Add book info if we have it
  const summary = jobSummaries.get(jobId);
  if (summary) {
    entry.bookTitle = summary.bookTitle;
    entry.author = summary.author;
  }

  await writeLog(entry);
}

export async function logError(
  jobId: string,
  message: string,
  error: Error | any,
  details?: any
): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    jobId,
    message,
    details,
    error: {
      message: error.message || String(error),
      stack: error.stack,
      code: error.code
    }
  };

  // Add book info if we have it
  const summary = jobSummaries.get(jobId);
  if (summary) {
    entry.bookTitle = summary.bookTitle;
    entry.author = summary.author;
  }

  await writeLog(entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Management
// ─────────────────────────────────────────────────────────────────────────────

export async function startJob(
  jobId: string,
  bookTitle: string,
  author: string,
  settings?: any
): Promise<void> {
  const summary: JobSummary = {
    jobId,
    bookTitle,
    author,
    startTime: new Date().toISOString(),
    status: 'running',
    settings
  };

  jobSummaries.set(jobId, summary);

  await log('INFO', jobId, 'Job started', {
    bookTitle,
    author,
    settings
  });

  // Also write summary to separate summary file
  await writeSummaryFile();
}

export async function updateJobProgress(
  jobId: string,
  updates: Partial<JobSummary>
): Promise<void> {
  const summary = jobSummaries.get(jobId);
  if (!summary) return;

  Object.assign(summary, updates);

  await writeSummaryFile();
}

export async function completeJob(
  jobId: string,
  outputPath?: string
): Promise<void> {
  const summary = jobSummaries.get(jobId);
  if (!summary) return;

  summary.status = 'completed';
  summary.endTime = new Date().toISOString();
  summary.outputPath = outputPath;

  // Calculate duration
  if (summary.startTime) {
    const start = new Date(summary.startTime).getTime();
    const end = new Date(summary.endTime).getTime();
    summary.duration = Math.floor((end - start) / 1000);
  }

  await log('INFO', jobId, 'Job completed', {
    duration: summary.duration,
    outputPath
  });

  await writeSummaryFile();
}

export async function failJob(
  jobId: string,
  error: string
): Promise<void> {
  const summary = jobSummaries.get(jobId);
  if (!summary) return;

  summary.status = 'failed';
  summary.endTime = new Date().toISOString();
  summary.error = error;

  // Calculate duration
  if (summary.startTime) {
    const start = new Date(summary.startTime).getTime();
    const end = new Date(summary.endTime).getTime();
    summary.duration = Math.floor((end - start) / 1000);
  }

  await log('ERROR', jobId, 'Job failed', {
    error,
    duration: summary.duration
  });

  await writeSummaryFile();
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary Management
// ─────────────────────────────────────────────────────────────────────────────

async function writeSummaryFile(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const summaryFile = path.join(logsPath, `summary-${today}.json`);

  const summariesArray = Array.from(jobSummaries.values());

  try {
    await fs.writeFile(
      summaryFile,
      JSON.stringify(summariesArray, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Failed to write summary file:', error);
  }
}

async function loadExistingSummaries(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const summaryFile = path.join(logsPath, `summary-${today}.json`);

  try {
    const data = await fs.readFile(summaryFile, 'utf8');
    const summaries = JSON.parse(data) as JobSummary[];

    for (const summary of summaries) {
      jobSummaries.set(summary.jobId, summary);
    }
  } catch (error) {
    // File might not exist yet, that's OK
    if ((error as any).code !== 'ENOENT') {
      console.error('Failed to load existing summaries:', error);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function getTodaysSummary(): Promise<JobSummary[]> {
  return Array.from(jobSummaries.values());
}

export async function getRecentErrors(days: number = 7): Promise<LogEntry[]> {
  const errors: LogEntry[] = [];
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const logFile = path.join(logsPath, `audiobook-${dateStr}.log`);

    try {
      const content = await fs.readFile(logFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.level === 'ERROR') {
            errors.push(entry);
          }
        } catch (e) {
          // Invalid JSON line, skip
        }
      }
    } catch (error) {
      // File might not exist, continue
      continue;
    }
  }

  return errors.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export async function searchLogs(
  searchTerm: string,
  days: number = 7
): Promise<LogEntry[]> {
  const results: LogEntry[] = [];
  const today = new Date();
  const searchLower = searchTerm.toLowerCase();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const logFile = path.join(logsPath, `audiobook-${dateStr}.log`);

    try {
      const content = await fs.readFile(logFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.toLowerCase().includes(searchLower)) {
          try {
            const entry = JSON.parse(line) as LogEntry;
            results.push(entry);
          } catch (e) {
            // Invalid JSON line, skip
          }
        }
      }
    } catch (error) {
      // File might not exist, continue
      continue;
    }
  }

  return results.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

export async function generateDailySummaryReport(): Promise<string> {
  const summaries = await getTodaysSummary();
  const errors = await getRecentErrors(1); // Today's errors only

  let report = `Audiobook Conversion Summary - ${new Date().toISOString().split('T')[0]}\n`;
  report += '='.repeat(60) + '\n\n';

  // Job Statistics
  const completed = summaries.filter(s => s.status === 'completed').length;
  const failed = summaries.filter(s => s.status === 'failed').length;
  const running = summaries.filter(s => s.status === 'running').length;

  report += `Total Jobs: ${summaries.length}\n`;
  report += `Completed: ${completed}\n`;
  report += `Failed: ${failed}\n`;
  report += `Still Running: ${running}\n\n`;

  // Completed Jobs
  if (completed > 0) {
    report += 'COMPLETED JOBS:\n';
    report += '-'.repeat(40) + '\n';
    for (const job of summaries.filter(s => s.status === 'completed')) {
      report += `• ${job.bookTitle} by ${job.author}\n`;
      report += `  Job ID: ${job.jobId}\n`;
      report += `  Duration: ${formatDuration(job.duration || 0)}\n`;
      report += `  Output: ${job.outputPath}\n\n`;
    }
  }

  // Failed Jobs
  if (failed > 0) {
    report += 'FAILED JOBS:\n';
    report += '-'.repeat(40) + '\n';
    for (const job of summaries.filter(s => s.status === 'failed')) {
      report += `• ${job.bookTitle} by ${job.author}\n`;
      report += `  Job ID: ${job.jobId}\n`;
      report += `  Error: ${job.error}\n`;
      report += `  Duration before failure: ${formatDuration(job.duration || 0)}\n\n`;
    }
  }

  // Running Jobs
  if (running > 0) {
    report += 'STILL RUNNING:\n';
    report += '-'.repeat(40) + '\n';
    for (const job of summaries.filter(s => s.status === 'running')) {
      const runtime = Math.floor(
        (Date.now() - new Date(job.startTime).getTime()) / 1000
      );
      report += `• ${job.bookTitle} by ${job.author}\n`;
      report += `  Job ID: ${job.jobId}\n`;
      report += `  Running for: ${formatDuration(runtime)}\n\n`;
    }
  }

  // Errors Summary
  if (errors.length > 0) {
    report += '\nERROR DETAILS:\n';
    report += '-'.repeat(40) + '\n';
    for (const error of errors) {
      report += `[${error.timestamp}] ${error.bookTitle || error.jobId}\n`;
      report += `  ${error.message}\n`;
      if (error.error) {
        report += `  ${error.error.message}\n`;
      }
      report += '\n';
    }
  }

  return report;
}