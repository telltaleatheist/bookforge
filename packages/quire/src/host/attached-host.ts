/**
 * The DISPLAY host: any WebContents the application already owns and SHOWS.
 *
 * This is the one that matters. The picker's product is a page the user reads —
 * live DOM, real fonts, selectable text, working links — not a picture of one.
 * `AttachedWebContentsHost` wraps a `<webview>`'s WebContents, or a
 * `WebContentsView` positioned over a grid cell, and drives it with the SAME
 * strategy scripts the analysis host is driven with. The pages the user sees are
 * therefore the pages that were measured, by construction rather than by
 * agreement.
 *
 * It intentionally does NOT implement `capture`. On a display host the page is
 * already in front of the user; rasterizing it would be a step backwards.
 *
 * The caller creates the WebContents (only the app knows where it goes in its
 * own layout), but quire checks it before letting a book near it: same session,
 * same sandbox, verified from the live process.
 */
import { quireFail } from '../errors';
import { assertSandboxed, type QuireHost } from './host';
import { QUIRE_ISOLATED_WORLD_ID } from './offscreen-host';

export class AttachedWebContentsHost implements QuireHost {
  private wc: Electron.WebContents | null;
  private readonly messages: string[] = [];

  get consoleMessages(): readonly string[] { return this.messages; }

  private constructor(wc: Electron.WebContents) {
    this.wc = wc;
  }

  /**
   * @param webContents a surface the app owns and displays — a `<webview>`'s
   *   WebContents, or `view.webContents` for a WebContentsView.
   * @param expectedSession the document's session. A display surface on the wrong
   *   session cannot resolve `quire://` at all, which would show up as a blank
   *   cell rather than as an error, so it is checked here.
   */
  static attach(
    webContents: Electron.WebContents,
    expectedSession: Electron.Session,
  ): AttachedWebContentsHost {
    if (webContents.isDestroyed()) {
      quireFail('HOST_DESTROYED', 'the WebContents handed to quire is already destroyed');
    }
    if (webContents.session !== expectedSession) {
      quireFail(
        'HOST_WRONG_SESSION',
        'the display surface is on a different Electron session than the document, so it '
        + 'cannot resolve quire:// URLs. Create it with the session from '
        + 'QuireDocument.session — quire will not silently render an empty page.',
      );
    }
    assertSandboxed(webContents, 'the quire display surface');

    const host = new AttachedWebContentsHost(webContents);
    webContents.on('console-message', (_e: unknown, _level: number, message: string) => {
      host.messages.push(message);
    });
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return host;
  }

  private require(): Electron.WebContents {
    if (!this.wc || this.wc.isDestroyed()) {
      quireFail('HOST_DESTROYED', 'the quire display surface has been destroyed');
    }
    return this.wc;
  }

  async load(url: string): Promise<void> {
    await this.require().loadURL(url);
  }

  async evaluate(expression: string): Promise<string> {
    const result = await this.require().executeJavaScriptInIsolatedWorld(
      QUIRE_ISOLATED_WORLD_ID,
      [{ code: expression }],
    );
    if (typeof result !== 'string') {
      quireFail(
        'EVALUATE_SHAPE',
        `the script returned ${typeof result}, not the JSON string it is required to return`,
      );
    }
    return result;
  }

  async resize(_width: number, _height: number): Promise<void> {
    // A display surface is sized by the application's own layout — the grid cell
    // decides, not quire. Silently resizing someone else's view would be quire
    // reaching outside its business.
    quireFail(
      'HOST_NOT_RESIZABLE',
      'a display surface is sized by the application that owns it. Size the view to the '
      + "page box (QuirePageMount.width/height) in the app's own layout code.",
    );
  }

  /** Detaches quire's listeners. The WebContents belongs to the caller; it is not destroyed. */
  destroy(): void {
    this.wc = null;
  }
}
