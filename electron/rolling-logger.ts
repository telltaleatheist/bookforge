/**
 * Rolling Logger
 *
 * Platform-aware file logger with automatic rotation:
 * - Mac: ~/Library/Logs/BookForge/
 * - Windows: %APPDATA%/BookForge/logs/
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

/**
 * WHERE THIS MACHINE'S LOGS GO — the one owner, for every diagnostic log the
 * app streams to disk.
 *
 * MACHINE-LOCAL ON PURPOSE, and that is the whole point of the function. The
 * library is a Syncthing/SMB tree shared by the Mac and the PC, every write to
 * it must be atomic (CLAUDE.md, Unified Project Architecture), and an appending
 * WriteStream is the opposite of atomic — two machines both truncating one
 * `worker-output.log` at start would leave a log that is neither's. So
 * `bookforge.log`, `tts.log`, `foundry.log`, `reassembly.log` and
 * `worker-output.log` all live HERE, beside each other, where somebody
 * debugging this machine looks.
 *
 * Exported since 2026-09-20 because `parallel-tts-bridge.ts` carried a THIRD
 * copy of this platform switch behind a `libraryPath` parameter it never read —
 * a signature that told every reader the worker log followed the library, which
 * it never has (unchanged since the function was written). One owner, so the
 * next reader cannot be told that again.
 */
export function machineLogDirectory(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    // macOS: ~/Library/Logs/BookForge/
    return path.join(os.homedir(), 'Library', 'Logs', 'BookForge');
  }
  if (platform === 'win32') {
    // Windows: %APPDATA%/BookForge/logs/
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'BookForge', 'logs');
  }
  // Linux/other: ~/.local/share/BookForge/logs/
  return path.join(os.homedir(), '.local', 'share', 'BookForge', 'logs');
}

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
  /**
   * THE APP'S OWN DECLARATION THAT IT IS THE APP — set by {@link init}, and the
   * only thing that ever opens a file in this machine's log directory.
   *
   * ── The finding (bug hunt 2026-09-20) ─────────────────────────────────────
   *
   * `write()` used to open the log lazily: `if (!this.initialized) await
   * this.init()`. That is fine for the app, which calls `initializeLoggers()`
   * as the first thing in `whenReady`, and wrong for everything else that
   * `require`s a built module. When the queue keepers drove the real engine
   * through PK1's `logFailure()`, lines like *"[QUEUE] Book — Narrate failed:
   * the model would not load"* — fabricated failures for books that were
   * never queued — landed in Owen's `~/Library/Logs/BookForge/bookforge.log`
   * at 18:01Z, in among the night's real ones. A log somebody debugs at 9am
   * cannot contain a test's inventions.
   *
   * ── Why THIS rule and not a keeper flag ───────────────────────────────────
   *
   * An env var (`BOOKFORGE_KEEPER=1`) only works if every harness remembers to
   * set it, and the harness that caused this did not exist when the rule would
   * have been written. `init()` is the opposite: a POSITIVE declaration that
   * only the app makes, in one place, which no test process can satisfy by
   * accident. A logger nobody opened writes to the console and creates nothing.
   *
   * A write that arrives while an init is still in flight WAITS for it rather
   * than going to the console, so a caller that opens its own logger
   * (`text-server.ts`) loses nothing to the gap.
   */
  private opening: Promise<void> | null = null;

  constructor(config: LoggerConfig) {
    this.logDir = this.getLogDirectory();
    this.logPath = path.join(this.logDir, `${config.name}.log`);
    this.backupPath = path.join(this.logDir, `${config.name}.backup.log`);
    this.maxSize = config.maxSize || MAX_LOG_SIZE;
    this.consoleOutput = config.consoleOutput ?? (process.env.NODE_ENV !== 'production');
  }

  /** Where this machine's logs go — see {@link machineLogDirectory}. */
  private getLogDirectory(): string {
    return machineLogDirectory();
  }

  /**
   * Initialize the logger - create directory and open file stream
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.opening !== null) return this.opening;
    this.opening = this.open();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** {@link init}'s body. Separate so a second caller can await the first. */
  private async open(): Promise<void> {
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
    /*
     * NO LAZY OPEN — see {@link opening}. The file belongs to the process that
     * declared itself the app by calling `init()`; a write from any other
     * process goes to the console, which is where whoever is running it is
     * looking anyway.
     */
    if (!this.initialized) {
      if (this.opening === null) {
        this.toConsole(level, new Date().toISOString(), message, data);
        return;
      }
      await this.opening;
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

    this.toConsole(level, timestamp, message, data);
  }

  /**
   * The console half, which is also the WHOLE of a logger nobody opened.
   *
   * It honours `consoleOutput` on the ordinary path — a logger built with it
   * false (`text-server`) is deliberately file-only — but a dropped line from an
   * unopened logger is printed regardless of that flag when it is a WARN or an
   * ERROR: the alternative is a harness losing the one sentence that says why
   * something failed, which is the failure this whole rule exists to avoid
   * repeating in the other direction.
   */
  private toConsole(level: LogLevel, timestamp: string, message: string, data?: any): void {
    const loud = level === 'ERROR' || level === 'WARN';
    if (!this.consoleOutput && !(loud && !this.initialized)) return;
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
let foundryLogger: RollingLogger | null = null;

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
 * THE FOUNDRY CLI'S OWN LOG — `foundry.log`, beside `tts.log`.
 *
 * Everything the hosted Foundry engine says used to land in memory and nowhere
 * else: `foundry-app`'s engine accumulated the child's stdout/stderr to drive
 * one row message, and `bookforge.log` (this module's main logger) only ever
 * carries explicit calls, so it ends at the last STARTUP line. On 2026-09-19 a
 * whole night of Foundry clean-text failures left `grep -c '[job]' 0` across
 * every log on disk, and the queue rows that had carried the reasons had been
 * stopped, which erases them (P5/F7). A book that failed at 3am must be
 * answerable at 9am.
 *
 * ONE log for every hosted Foundry run, not one per job: the CLI is a single
 * child and its lines already name their job. Fed from `foundry-host-queue.ts`,
 * which is the one door every run goes through.
 */
export function getFoundryLogger(): RollingLogger {
  if (!foundryLogger) {
    foundryLogger = new RollingLogger({ name: 'foundry' });
  }
  return foundryLogger;
}

/**
 * Initialize all loggers
 */
export async function initializeLoggers(): Promise<void> {
  await Promise.all([
    getMainLogger().init(),
    getTTSLogger().init(),
    getReassemblyLogger().init(),
    getFoundryLogger().init()
  ]);
}

/**
 * Close all loggers
 */
export async function closeLoggers(): Promise<void> {
  await Promise.all([
    mainLogger?.close(),
    ttsLogger?.close(),
    reassemblyLogger?.close(),
    foundryLogger?.close()
  ]);
}

// Export the class for custom logger creation
export { RollingLogger };
