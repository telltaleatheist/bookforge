/**
 * Where a paginated document lives.
 *
 * A host is a sandboxed web surface that can load a `quire://` URL and run a
 * pure script against it. That is the whole contract. In particular a host does
 * NOT have to be invisible:
 *
 *  - {@link OffscreenWindowHost} is the ANALYSIS host — a hidden, offscreen
 *    BrowserWindow used to work out page counts and the id → page map. Nobody
 *    looks at it.
 *  - {@link AttachedWebContentsHost} is the DISPLAY host — any WebContents the
 *    application already owns and shows (a `<webview>` in the picker grid, a
 *    WebContentsView). The user looks straight at it: real DOM, real fonts,
 *    selectable text, no raster round trip.
 *
 * Both drive the same pagination core. Invisibility is a property of one host,
 * never of quire. The SANDBOX, on the other hand, is a property of quire: every
 * host is required to satisfy {@link QUIRE_REQUIRED_WEB_PREFERENCES}, and
 * {@link assertSandboxed} checks it rather than trusting it.
 */
import { quireFail } from '../errors';

/**
 * The web preferences a quire host must have. Book HTML is untrusted; these are
 * not tuning knobs.
 */
export const QUIRE_REQUIRED_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  enableBlinkFeatures: '',
} as const;

export interface QuireHost {
  /** Load a `quire://` URL and resolve once the document has finished loading. */
  load(url: string): Promise<void>;
  /**
   * Run a self-contained expression against the loaded document in an ISOLATED
   * world and return whatever string it evaluated to.
   *
   * Isolated, not the main world, for two reasons that both matter: the book
   * cannot see or tamper with the measurement, and the measurement is not
   * subject to the page's `script-src 'none'` — which is exactly the CSP the
   * book is meant to be pinned under.
   */
  evaluate(expression: string): Promise<string>;
  /** Resize the surface, in CSS pixels. */
  resize(width: number, height: number): Promise<void>;
  /**
   * Rasterize the surface. OPTIONAL: a display host has no reason to implement
   * it, because on a display host the user is already looking at the page.
   */
  capture?(width: number, height: number): Promise<Buffer>;
  /** Release the surface. Safe to call twice. */
  destroy(): void;
  /** Console messages the surface produced — the CSP violations land here. */
  readonly consoleMessages: readonly string[];
}

/**
 * Verify a WebContents really is sandboxed the way quire requires, from the
 * live process rather than from the options someone passed at construction.
 */
export function assertSandboxed(webContents: Electron.WebContents, what: string): void {
  const prefs = (webContents as unknown as {
    getLastWebPreferences?: () => Record<string, unknown> | null;
  }).getLastWebPreferences?.() ?? null;
  if (!prefs) {
    quireFail(
      'SANDBOX_UNVERIFIABLE',
      `${what}: its web preferences could not be read back, so quire cannot confirm the `
      + 'book would be sandboxed. Refusing to load untrusted markup into it.',
    );
  }
  const wrong: string[] = [];
  for (const [key, required] of Object.entries(QUIRE_REQUIRED_WEB_PREFERENCES)) {
    const actual = prefs[key];
    // Electron omits a preference it left at its default. `sandbox`, `webSecurity`
    // and `contextIsolation` default to the values quire wants, so absence is
    // agreement — but a preference that is PRESENT and disagrees is a refusal.
    if (actual !== undefined && actual !== required) {
      wrong.push(`${key}=${JSON.stringify(actual)} (quire requires ${JSON.stringify(required)})`);
    }
  }
  if (wrong.length > 0) {
    quireFail(
      'SANDBOX_VIOLATION',
      `${what}: ${wrong.join(', ')}. Book HTML is untrusted content and quire will not `
      + 'load it into a surface that is not sandboxed.',
    );
  }
}
