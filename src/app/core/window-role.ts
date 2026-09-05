/**
 * Which window this renderer IS.
 *
 * BookForge runs the same Angular app in several BrowserWindows. The main window
 * is the app; the others are single-purpose popups opened on a hash route
 * (`#/listen`, `#/editor`). They share every root-provided
 * service, so anything that must happen ONCE PER EVENT rather than once per
 * window has to ask which window it is running in — the queue broadcasts
 * `jobs:changed` and `jobs:step-finished` to every one of them.
 *
 * This lived as a computed on the App component, where only the shell could read
 * it. It is a fact about the window, not about a component, so it lives here and
 * the shell reads it from here too.
 */

/** The hash routes that open in a window of their own. */
// `#/alignment` was here until 2026-09-05. It opened the sentence-alignment
// popup, which only the bilingual translate pipeline ever raised; the route, its
// component and the window that loaded it all went with that feature.
const STANDALONE_ROUTES = ['#/editor', '#/listen'] as const;

/**
 * True in a popup window (listen / editor), false in the main one.
 *
 * The app uses hash routing, so the route is in the fragment and not the path.
 * Read at call time rather than cached: a window is opened AT its route and
 * never navigates out of it, but a cached answer would be wrong for the beat
 * before the first navigation resolves.
 */
export function isStandaloneWindow(): boolean {
  const hash = window.location.hash;
  return STANDALONE_ROUTES.some((route) => hash.startsWith(route));
}

/**
 * Whether THIS window should say a thing that every window was told about.
 *
 * A step finishing broadcasts to all of them, and three copies of "finished
 * narrating" is three times the news. The rule: the FOCUSED window says it,
 * because that is the one the user is looking at. When the app has no focused
 * window at all — it is in the background, or the user is in another
 * application — the MAIN window says it, so the news is waiting where they will
 * come back to.
 *
 * The second half needs main to answer, because a renderer can see its own focus
 * and nothing else's. `window:any-focused` is that question; asked only when this
 * window is the unfocused main one, which is the only case where the answer
 * changes anything.
 */
export async function shouldAnnounceHere(): Promise<boolean> {
  if (document.hasFocus()) return true;
  if (isStandaloneWindow()) return false;

  // Cast rather than a global declaration: `Window.electron` is already declared
  // in several files, and a second declaration with a narrower shape is a
  // compile error rather than a merge.
  const bridge = (window as unknown as {
    electron?: { window?: { anyFocused?: () => Promise<{ focused: boolean }> } };
  }).electron;
  const anyFocused = bridge?.window?.anyFocused;
  if (!anyFocused) {
    throw new Error(
      'The main window cannot tell whether any BookForge window has focus: the '
      + 'window:any-focused door is missing from the preload bridge.',
    );
  }
  const result = await anyFocused();
  return !result.focused;
}
