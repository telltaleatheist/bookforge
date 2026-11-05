/**
 * What BookForge's copy of the window adds (docs/REORG-PLAN.md, B3).
 *
 * NO PAGE TOOLS. Owen ruled that BookForge's window has none: no light table and
 * no "Edit book". The two doors the hosted window still had, the action menu's
 * "Edit book" and "Edit the photographs", are deleted from this copy rather than
 * switched off, in tools/foundry-window-edits.patch, so a re-copy keeps them out.
 */

/**
 * A line BookForge says in this window's notice tray (preload's `bookforgeWindow`).
 * The key is always there in BookForge; missing, this window was not opened by it,
 * and that is said rather than quietly listening to nothing.
 */
export function onHostNotice(listener: (text: string) => void): () => void {
  const bridge = (window as unknown as {
    bookforgeWindow?: { onHostNotice(listener: (text: string) => void): () => void };
  }).bookforgeWindow;
  if (bridge === undefined) {
    throw new Error('This window has no bookforgeWindow bridge, so it was not opened by BookForge.');
  }
  return bridge.onHostNotice(listener);
}
