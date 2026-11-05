/**
 * app.model — the small platform and drag facts the shell asks.
 */
/**
 * Whether this window stands on macOS — asked once, for the one branch whose
 * behaviour genuinely differs by platform (`undo`'s editable arm; the argument
 * lives there). `navigator.platform` is deprecated-but-shipped and is the only
 * synchronous answer the renderer has; Electron gives every window the real
 * value.
 */
export const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

/** Whether a drag is carrying files from outside the app, rather than a library row. */
export function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}
