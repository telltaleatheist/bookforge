/**
 * The ANALYSIS host: a hidden, offscreen BrowserWindow.
 *
 * It exists to answer "how many pages, and which id landed where". Nobody ever
 * sees it, it is never shown, and it is destroyed on every exit path including
 * the failing ones. It is NOT the display path — see `AttachedWebContentsHost`
 * and `mountQuirePage`, which put the same paginated DOM in front of the user.
 *
 * `offscreen: true` is what lets a never-shown window still produce a raster for
 * `toPng`, and it also pins compositing to software, which is one fewer source
 * of run-to-run variation in a measurement.
 */
import { quireFail } from '../errors';
import { assertSandboxed, QUIRE_REQUIRED_WEB_PREFERENCES, type QuireHost } from './host';

export interface OffscreenHostOptions {
  session: Electron.Session;
  width: number;
  height: number;
}

export class OffscreenWindowHost implements QuireHost {
  private win: Electron.BrowserWindow | null;
  private readonly messages: string[] = [];

  get consoleMessages(): readonly string[] { return this.messages; }

  private constructor(win: Electron.BrowserWindow) {
    this.win = win;
  }

  static async create(options: OffscreenHostOptions): Promise<OffscreenWindowHost> {
    const { BrowserWindow } = require('electron') as typeof Electron;
    const win = new BrowserWindow({
      show: false,
      width: options.width,
      height: options.height,
      useContentSize: true,
      webPreferences: {
        ...QUIRE_REQUIRED_WEB_PREFERENCES,
        session: options.session,
        offscreen: true,
        backgroundThrottling: false,
        spellcheck: false,
        images: true,
        // No preload. There is nothing for the book to talk to, so there is no
        // bridge to get wrong: measurement is injected from the main process
        // into an isolated world and returns a string.
      },
    });

    const host = new OffscreenWindowHost(win);
    win.webContents.on('console-message', (_e: unknown, _level: number, message: string) => {
      host.messages.push(message);
    });
    // A book cannot open windows, and a click on a book's link cannot navigate
    // the surface out from under the measurement.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    assertSandboxed(win.webContents, 'the quire analysis window');
    return host;
  }

  private require(): Electron.BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      quireFail('HOST_DESTROYED', 'the quire analysis window has been destroyed');
    }
    return this.win;
  }

  async load(url: string): Promise<void> {
    const win = this.require();
    await win.loadURL(url);
  }

  async evaluate(expression: string): Promise<string> {
    const win = this.require();
    const result = await win.webContents.executeJavaScriptInIsolatedWorld(
      QUIRE_ISOLATED_WORLD_ID,
      [{ code: expression }],
    );
    if (typeof result !== 'string') {
      quireFail(
        'EVALUATE_SHAPE',
        `the measurement script returned ${typeof result}, not the JSON string it is required to return`,
      );
    }
    return result;
  }

  async resize(width: number, height: number): Promise<void> {
    const win = this.require();
    win.setContentSize(Math.ceil(width), Math.ceil(height));
  }

  async capture(width: number, height: number): Promise<Buffer> {
    const win = this.require();
    const image = await win.webContents.capturePage({
      x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height),
    });
    const size = image.getSize();
    if (size.width === 0 || size.height === 0) {
      quireFail('CAPTURE_EMPTY', 'the offscreen surface produced a zero-sized image');
    }
    // The surface rasterizes at the display's device scale factor, which is a
    // property of the machine and not of the request. Resample to exactly what
    // was asked for so the same page is the same PNG on every machine — this
    // changes the sampling, never the page.
    const exact = (size.width === Math.ceil(width) && size.height === Math.ceil(height))
      ? image
      : image.resize({ width: Math.ceil(width), height: Math.ceil(height), quality: 'best' });
    return exact.toPNG();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/**
 * The isolated world quire measures in. Chosen high to stay clear of the worlds
 * Electron's own contextIsolation preload uses (0 = main, 999 = isolated preload).
 */
export const QUIRE_ISOLATED_WORLD_ID = 31_337;
