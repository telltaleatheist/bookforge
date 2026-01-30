/**
 * Rolling Logger
 *
 * Platform-aware file logger with automatic rotation:
 * - Mac: ~/Library/Logs/BookForgeApp/
 * - Windows: %APPDATA%/BookForgeApp/logs/
 *
 * Rotation policy:
 * - At 2MB, current log moves to .backup
 * - If backup exists when rotating, delete it first
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Maximum log file size before rotation (2MB)
const MAX_LOG_SIZE = 2 * 1024 * 1024;

// Log levels
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LoggerConfig {
  name: string;           // Log file base name (e.g., 'bookforge' -> bookforge.log)
  maxSize?: number;       // Max size in bytes (default: 2MB)
  consoleOutput?: boolean; // Also log to console (default: true in dev)
}

class RollingLogger {
  private logDir: string;
  private logPath: string;
  private backupPath: string;
  private maxSize: number;
  private consoleOutput: boolean;
  private writeStream: fs.WriteStream | null = null;
  private currentSize: number = 0;
  private initialized: boolean = false;

  constructor(config: LoggerConfig) {
    this.logDir = this.getLogDirectory();
    this.logPath = path.join(this.logDir, `${config.name}.log`);
    this.backupPath = path.join(this.logDir, `${config.name}.backup.log`);
    this.maxSize = config.maxSize || MAX_LOG_SIZE;
    this.consoleOutput = config.consoleOutput ?? (process.env.NODE_ENV !== 'production');
  }

  /**
   * Get platform-specific log directory
   */
  private getLogDirectory(): string {
    const platform = os.platform();

    if (platform === 'darwin') {
      // macOS: ~/Library/Logs/BookForgeApp/
      return path.join(os.homedir(), 'Library', 'Logs', 'BookForgeApp');
    } else if (platform === 'win32') {
      // Windows: %APPDATA%/BookForgeApp/logs/
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'BookForgeApp', 'logs');
    } else {
      // Linux/other: ~/.local/share/BookForgeApp/logs/
      return path.join(os.homedir(), '.local', 'share', 'BookForgeApp', 'logs');
    }
  }

  /**
   * Initialize the logger - create directory and open file stream
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Ensure log directory exists
    await fs.promises.mkdir(this.logDir, { recursive: true });

    // Get current file size if exists
    try {
      const stats = await fs.promises.stat(this.logPath);
      this.currentSize = stats.size;

      // Check if we need to rotate on startup
      if (this.currentSize >= this.maxSize) {
        await this.rotate();
      }
    } catch (err) {
      // File doesn't exist yet, that's fine
      this.currentSize = 0;
    }

    // Open write stream in append mode
    this.writeStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.initialized = true;

    // Log startup
    this.info('Logger initialized', {
      logPath: this.logPath,
      platform: os.platform(),
      maxSize: this.maxSize
    });
  }

  /**
   * Rotate log files
   */
  private async rotate(): Promise<void> {
    // Close current stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }

    // Delete backup if exists
    try {
      await fs.promises.unlink(this.backupPath);
    } catch (err) {
      // Backup doesn't exist, that's fine
    }

    // Move current to backup
    try {
      await fs.promises.rename(this.logPath, this.backupPath);
    } catch (err) {
      // Current doesn't exist, that's fine
    }

    // Reset size counter
    this.currentSize = 0;

    // Reopen write stream
    this.writeStream = fs.createWriteStream(this.logPath, { flags: 'a' });
  }

  /**
   * Write a log entry
   */
  private async write(level: LogLevel, message: string, data?: any): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    const timestamp = new Date().toISOString();
    const entry: any = {
      timestamp,
      level,
      message
    };

    if (data !== undefined) {
      entry.data = data;
    }

    const line = JSON.stringify(entry) + '\n';
    const lineSize = Buffer.byteLength(line, 'utf8');

    // Check if we need to rotate
    if (this.currentSize + lineSize >= this.maxSize) {
      await this.rotate();
    }

    // Write to file
    if (this.writeStream) {
      this.writeStream.write(line);
      this.currentSize += lineSize;
    }

    // Console output
    if (this.consoleOutput) {
      const prefix = `[${timestamp}] [${level}]`;
      const consoleMsg = data ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;

      switch (level) {
        case 'ERROR':
          console.error(consoleMsg);
          break;
        case 'WARN':
          console.warn(consoleMsg);
          break;
        case 'DEBUG':
          console.debug(consoleMsg);
          break;
        default:
          console.log(consoleMsg);
      }
    }
  }

  // Public logging methods
  debug(message: string, data?: any): void {
    this.write('DEBUG', message, data).catch(console.error);
  }

  info(message: string, data?: any): void {
    this.write('INFO', message, data).catch(console.error);
  }

  warn(message: string, data?: any): void {
    this.write('WARN', message, data).catch(console.error);
  }

  error(message: string, data?: any): void {
    this.write('ERROR', message, data).catch(console.error);
  }

  /**
   * Get the log file path
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Get the log directory
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * Flush and close the logger
   */
  async close(): Promise<void> {
    if (this.writeStream) {
      return new Promise((resolve) => {
        this.writeStream!.end(() => {
          this.writeStream = null;
          this.initialized = false;
          resolve();
        });
      });
    }
  }
}

// Singleton instances for different log categories
let mainLogger: RollingLogger | null = null;
let ttsLogger: RollingLogger | null = null;
let reassemblyLogger: RollingLogger | null = null;

/**
 * Get the main application logger
 */
export function getMainLogger(): RollingLogger {
  if (!mainLogger) {
    mainLogger = new RollingLogger({ name: 'bookforge' });
  }
  return mainLogger;
}

/**
 * Get the TTS-specific logger
 */
export function getTTSLogger(): RollingLogger {
  if (!ttsLogger) {
    ttsLogger = new RollingLogger({ name: 'tts' });
  }
  return ttsLogger;
}

/**
 * Get the reassembly-specific logger
 */
export function getReassemblyLogger(): RollingLogger {
  if (!reassemblyLogger) {
    reassemblyLogger = new RollingLogger({ name: 'reassembly' });
  }
  return reassemblyLogger;
}

/**
 * Initialize all loggers
 */
export async function initializeLoggers(): Promise<void> {
  await Promise.all([
    getMainLogger().init(),
    getTTSLogger().init(),
    getReassemblyLogger().init()
  ]);
}

/**
 * Close all loggers
 */
export async function closeLoggers(): Promise<void> {
  await Promise.all([
    mainLogger?.close(),
    ttsLogger?.close(),
    reassemblyLogger?.close()
  ]);
}

// Export the class for custom logger creation
export { RollingLogger };
