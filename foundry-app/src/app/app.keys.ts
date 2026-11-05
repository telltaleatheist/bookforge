/**
 * app.keys — the window's own keyboard: undo and the shortcuts.
 */
import { BookStacksService } from './core/book-stacks.service';
import { PositionSyncService } from './core/position-sync.service';
import { IS_MAC } from './app.model';
import type { App } from './app';

/**
 * Ctrl/Cmd+Z, and the one decision that has to be made out here.
 *
 * THERE ARE TWO UNDOS IN THIS WINDOW and the chord means whichever one the
 * caret is in. A text box — a rename input in the inspector, a settings field,
 * a paragraph being retyped on the sheet — has the browser's own history and
 * expects to keep it; that is what `role: 'undo'` used to give it, and taking it
 * away so the book could have the chord would have made typing worse to make
 * editing better. So a text field gets `execCommand`, which is exactly what the
 * role menu did, and everything else goes to the book viewer's stack. (There
 * were three while a chapter could be typed into an iframe this window could not
 * see a caret in; that frame is deleted — docs/RENDERER.md §7.)
 *
 * `execCommand` is deprecated and there is no replacement for programmatic
 * undo of a text field. It is what the platform still implements, and the
 * alternative is a chord that does nothing in a textarea.
 *
 * THE DOCUMENT IS RESOLVED HERE AND HANDED DOWN. `BookStacksService` sits at
 * the bottom of the service chain (docs/PLAN.md §4, unit 8c) and knows about a
 * map keyed by tab id and nothing else; "what is in front of the user" is the
 * stage's question. So the chord's raiser asks the stage and passes the answer,
 * which is the same shape the routing always had — it is only that the two
 * halves now live in the two services that own them. Null is legitimate and
 * gets its own sentence: the chord arrived over Home.
 */
export function undo(this: App, redo: boolean): void {
  const focused = document.activeElement;
  const editable = focused instanceof HTMLInputElement
    || focused instanceof HTMLTextAreaElement
    || (focused instanceof HTMLElement && focused.isContentEditable);
  if (editable) {
    /*
     * ── THE FIELD'S OWN UNDO RUNS ONCE, AND ON WINDOWS THAT MEANS NOT HERE ──
     *
     * Measured in a probe window (2026-08-23): a menu accelerator does NOT
     * swallow the keypress on Windows — the page receives the raw keydown
     * beside the menu click, so the browser's native undo already runs in the
     * focused field, and the `execCommand('undo')` this branch used to make
     * beside it was a SECOND undo per press. Two steps back for one chord, in
     * whichever text box had the caret, is the shape of "undo behaves broken
     * while I'm typing".
     *
     * ON MAC THE SYSTEM MENU CONSUMES THE KEY, so the native default never
     * fires and `execCommand` remains the only road to the field's history —
     * exactly the arrangement this branch was written for. So it is kept
     * there and only there.
     */
    if (IS_MAC) document.execCommand(redo ? 'redo' : 'undo');
    return;
  }
  const tab = this.stage.activeDocument();
  void (redo ? this.stacks.redo(tab) : this.stacks.undo(tab));
}

export function onKeyDown(this: App, event: KeyboardEvent): void {
  /*
   * ── Ctrl/Cmd+Z AND Ctrl/Cmd+Shift+Z, HERE AS WELL AS ON THE MENU ────────
   *
   * Owen, 2026-09-07: *"the undo button works, but ctrl/cmd+z only works
   * for some things."* The chord reached the book's stack by ONE road — the
   * Edit menu's accelerator, arriving as `menu:action` — and that road does
   * not exist wherever this window is hosted: BookForge's own Edit menu is
   * the platform's `role: 'undo'`, which is `webContents.undo()`, the focused
   * text field's history and nothing else. So hosted, the chord undid typing
   * and never a strike; the button, which calls the pane directly, always
   * did. "Some things" was the text boxes.
   *
   * THE KEYDOWN IS NOW THE ROAD ON WINDOWS AND LINUX, and the menu item is a
   * label with a click. A menu accelerator does not swallow the keypress
   * there (measured 2026-08-23 — the page receives the raw keydown beside
   * the menu click), so listening here AND registering the accelerator would
   * be two undos per press; the menu's Undo keeps its displayed chord and
   * stops registering it (`registerAccelerator: false`, electron/main.ts),
   * and a hosted window whose host registers the platform role still gets
   * this keydown because that role does not swallow it either.
   *
   * ON MAC THE SYSTEM MENU CONSUMES THE KEY before the page sees it, so
   * standalone this branch never fires there and the menu road stands as it
   * was. Hosted on a Mac the HOST's role menu consumes it the same way, and
   * the only fix is the host's: send `menu:action` `'undo'` to this window
   * when it is the focused one (docs/BOOKFORGE-HANDOFF.md §8b).
   *
   * A CARET IN A TEXT BOX IS LEFT ALONE, and no `preventDefault` — the
   * field's own history is the browser's default action for this very key,
   * which is the whole of what `undo`'s editable arm protects.
   */
  if ((event.key === 'z' || event.key === 'Z') && (event.ctrlKey || event.metaKey) && !event.altKey) {
    const focused = document.activeElement;
    const editable = focused instanceof HTMLInputElement
      || focused instanceof HTMLTextAreaElement
      || (focused instanceof HTMLElement && focused.isContentEditable);
    if (editable) return;
    event.preventDefault();
    this.undo(event.shiftKey);
    return;
  }
  if (event.key === 'Escape' && this.ui.ocrOpen()) {
    event.preventDefault();
    this.ui.closeOcr();
    return;
  }
  if (event.key === 'Escape' && this.ui.exportOpen()) {
    event.preventDefault();
    this.ui.closeExport();
    return;
  }
  if (event.key === 'Escape' && this.ui.translateOpen()) {
    event.preventDefault();
    this.ui.closeTranslate();
    return;
  }
  if (event.key === 'Escape' && this.ui.simplifyOpen()) {
    event.preventDefault();
    this.ui.closeSimplify();
    return;
  }
  if (event.key === 'Escape' && this.ui.askPresetsOpen()) {
    event.preventDefault();
    this.ui.closeAskPresets();
    return;
  }
  if (event.key === 'Escape' && this.ui.metadataOpen()) {
    event.preventDefault();
    this.ui.closeMetadata();
    return;
  }
  /*
   * Ctrl+Tab. `event.key` is 'Tab' with ctrlKey, and preventDefault is what
   * stops the browser moving focus through the rail's buttons instead. It
   * cycles the flat list of open documents, which is the only list there is —
   * Ctrl+1…5 went with the columns it was addressing (docs/PLAN.md §4, 8b).
   *
   * TWO HALVES, HERE, because stepping to the next document is the same
   * statement as clicking its row and the position has to follow. The mirror
   * (`standForTab`) is in `PositionSyncService`, which sits ABOVE the stage in
   * the dependency chain, so the stage answers with the id it landed on and the
   * gesture's own handler does the second half. It is exactly what the
   * workspace's pointerdown already does for the other gesture that means
   * "this one".
   */
  if (event.key === 'Tab' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    const next = this.stage.nextTab();
    if (next !== null) void this.positions.standForTab(next);
  }
}
