/**
 * Renderer-side: put a page in a container.
 *
 * This is the display half of the package and the only module in it that runs in
 * the renderer. It imports nothing — not Electron, not Node — so it can be
 * bundled into the Angular app without dragging the main-process half along.
 *
 * It takes a {@link QuirePageMount} (plain data, produced in the main process by
 * `QuireDocument.getPageMount` and sent over IPC) and mounts the page as a
 * `<webview>`: a real, sandboxed, out-of-process frame showing the book's real
 * DOM. The user gets selectable text, real fonts and working internal links —
 * the things a rasterized page cannot give them, and the reason this package
 * exists.
 *
 * The host renderer must have `webviewTag: true`. The GUEST does not, and
 * `mountQuirePage` sets the guest's preferences to quire's sandbox requirements
 * explicitly rather than inheriting whatever the host happens to have.
 *
 * ── One frame per page, and why that is the wasteful way ───────────────────
 *
 * This function mounts ONE page into ONE frame, which is the only thing that
 * works for both box models and is therefore what it does.
 *
 * Under `continuous-columns` that is also the only thing possible: a page is a
 * window onto its chapter's flow, so twelve pages of one chapter are twelve
 * frames of the same document, and a grid MUST virtualise.
 *
 * Under `fragmented-boxes` — what quire actually paginates with — every page of
 * a chapter is a separate DOM subtree inside ONE instance, so a grid can show
 * many pages from a single frame, and should: the prelude that builds those
 * subtrees is close to a megabyte and one frame per cell evaluates it once per
 * cell. {@link QuirePageMount.boxModel} says which regime is in force so a grid
 * does not have to assume.
 */
import type { QuirePageMount } from './types';

export interface MountedQuirePage {
  /** The frame element, already appended to the container. */
  readonly element: HTMLElement;
  /** Resolves once the page is loaded and scrolled to the right column. */
  readonly ready: Promise<void>;
  /** Remove the frame and release it. Safe to call twice. */
  destroy(): void;
}

export interface MountQuirePageOptions {
  /**
   * The Electron session partition the document is confined to. It is part of
   * the mount URL's meaning: a webview on any other partition cannot resolve
   * `quire://` at all.
   */
  partition: string;
  /**
   * Show the document AS IT FLOWS instead of as pages: the frame loads the
   * same served bytes under the same sandbox, but neither the fragmenter
   * prelude nor the present script runs, so no page boxes are ever built and
   * the chapter reads top to bottom the way the publisher wrote it.
   *
   * What this deliberately does NOT change: identity. The stamps are in the
   * served bytes, so `data-quire-id` is present and pointable exactly as in a
   * paginated frame; only the pagination — a thing this frame no longer has —
   * is absent. The caller styles and measures the flow itself, the same way a
   * grid arranges page boxes itself.
   */
  flow?: boolean;
}

/**
 * Mount `mount` inside `container`.
 *
 * The returned `ready` promise rejects — loudly, naming the page — if the frame
 * fails to load or if the present script cannot bring the requested column to
 * the origin. A cell that quietly shows page 0 while claiming to be page 40 is
 * the failure this refuses to produce.
 */
export function mountQuirePage(
  mount: QuirePageMount,
  container: HTMLElement,
  options: MountQuirePageOptions,
): MountedQuirePage {
  // The scale is the mount's, not the caller's: the present script carries the
  // scale it was built for, so asking for a different one here would show a page
  // at a size its own script disagrees with. Ask the main process for a mount at
  // the scale you want — getPageMount is cheap.
  const scale = mount.scale;

  const frame = document.createElement('webview') as HTMLElement & {
    src: string;
    partition: string;
    executeJavaScript(code: string): Promise<unknown>;
    addEventListener(type: string, listener: (e: any) => void): void;
    removeEventListener(type: string, listener: (e: any) => void): void;
  };
  frame.setAttribute('src', mount.url);
  frame.setAttribute('partition', options.partition);
  // The guest's sandbox is stated here, not inherited. These are the same
  // requirements QUIRE_REQUIRED_WEB_PREFERENCES states for the analysis window.
  frame.setAttribute(
    'webpreferences',
    'sandbox=yes,contextIsolation=yes,nodeIntegration=no,webSecurity=yes,'
    + 'allowRunningInsecureContent=no,experimentalFeatures=no,webviewTag=no',
  );
  frame.setAttribute('disablewebsecurity', 'off');
  frame.style.display = 'block';
  frame.style.border = '0';
  frame.style.width = `${mount.width * scale}px`;
  frame.style.height = `${mount.height * scale}px`;

  let destroyed = false;

  const ready = new Promise<void>((resolve, reject) => {
    const onFail = (e: any): void => {
      cleanup();
      reject(new Error(
        `[quire/MOUNT_LOAD_FAILED] page ${mount.page} (${mount.document}) failed to load `
        + `${mount.url}: ${e?.errorDescription ?? 'unknown error'} (${e?.errorCode ?? '?'})`,
      ));
    };
    const onReady = (): void => {
      cleanup();
      if (destroyed) { resolve(); return; }
      // A flow mount is ready when the document is: there are no page boxes to
      // build and no page to bring to the origin, so running the pagination
      // scripts would manufacture the very structure this mount exists to skip.
      if (options.flow === true) { resolve(); return; }
      // The prelude first, and only then the page. Under `fragmented-boxes` the
      // page boxes do not exist in the served bytes — they are built in the
      // frame by the strategy's own engine — so a present script run without it
      // would be looking for a page that has not been made yet.
      const prelude = mount.preludeScript === null
        ? Promise.resolve()
        : frame.executeJavaScript(mount.preludeScript).then((raw) => {
          const parsed = JSON.parse(String(raw)) as { ok?: boolean; error?: string };
          if (parsed.ok !== true) {
            throw new Error(
              `[quire/MOUNT_PRELUDE_FAILED] page ${mount.page} (${mount.document}): `
              + `${parsed.error ?? String(raw).slice(0, 200)}`);
          }
        });
      prelude
        .then(() => frame.executeJavaScript(mount.presentScript))
        .then((raw) => {
          const parsed = JSON.parse(String(raw)) as { ok?: boolean; error?: string };
          if (parsed.error) {
            throw new Error(
              `[quire/MOUNT_PRESENT_FAILED] page ${mount.page} (${mount.document}, local page `
              + `${mount.localPage}): ${parsed.error}`);
          }
          resolve();
        })
        .catch(reject);
    };
    const cleanup = (): void => {
      frame.removeEventListener('did-finish-load', onReady);
      frame.removeEventListener('did-fail-load', onFail);
    };
    frame.addEventListener('did-finish-load', onReady);
    frame.addEventListener('did-fail-load', onFail);
  });

  container.appendChild(frame);

  return {
    element: frame,
    ready,
    destroy(): void {
      destroyed = true;
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    },
  };
}
