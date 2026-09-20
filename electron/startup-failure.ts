/**
 * THE WINDOW THAT SAYS WHY THERE IS NO WINDOW.
 *
 * `app.whenReady().then(async () => { … })` in `main.ts` spans a thousand
 * lines and, until 2026-09-20, had no `.catch`. One rejection anywhere in it —
 * a corrupt `queue-engine.json` read, a plugin that threw, a library volume
 * that went away between two awaits — and startup simply STOPPED where it
 * stood, before `createWindow()`. On darwin `window-all-closed` does not quit,
 * so the process stayed up with no window and no message: the only way out was
 * a kill, which skips `before-quit`, which is how a Crucible render is left
 * holding a card for an app that no longer exists (P11, and the seed failure
 * S7 that started the hunt).
 *
 * So a failed startup now DRAWS something. Not a dialog — Owen, 2026-09-17:
 * *"no js alerts. ever."* — a plain page in a real window, naming the step that
 * threw, because "BookForge did not open" is not a report anybody can act on
 * and "BookForge did not open: starting the queue" is.
 *
 * The two builders are pure and live here so a keeper can read the page back
 * (`tools/test-startup-failure.js`): the one thing this page must never do is
 * fail to render because of how it was built.
 */

/** The step names startup announces. Free-form prose — it is read by a person. */
export type StartupPhase = string;

/**
 * The log line, and the line the page leads with.
 *
 * Names the STEP first because that is the actionable half: two people reading
 * "Cannot read properties of undefined" learn nothing, and both know what to do
 * with "while starting the queue".
 */
export function startupFailureLine(phase: StartupPhase, message: string): string {
  const said = message.trim() === '' ? 'no reason given' : message.trim();
  return `BookForge could not finish starting up while ${phase}: ${said}`;
}

/**
 * The page itself, as a complete HTML document.
 *
 * ESCAPED, because the message is an arbitrary `Error.message` — a path with a
 * `<` in it, or a thrown string holding markup, would otherwise rewrite the
 * page it is being reported on. Returned as a document rather than a `data:`
 * URL so the caller owns the encoding (a `data:text/html,` URL needs its own
 * percent-encoding pass, and doing both here would double-encode).
 */
export function startupFailureHtml(phase: StartupPhase, message: string): string {
  const esc = (s: string): string => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return '<html><head><meta charset="utf-8"><title>BookForge did not start</title></head>'
    + '<body style="background:#1a1a1a;color:#fff;font-family:system-ui;padding:40px;line-height:1.5">'
    + '<h1 style="font-size:20px;margin:0 0 12px">BookForge did not finish starting up</h1>'
    + `<p style="margin:0 0 8px">It stopped while <strong>${esc(phase)}</strong>.</p>`
    + `<pre style="white-space:pre-wrap;background:#000;padding:16px;border-radius:6px;margin:0 0 16px">${esc(message)}</pre>`
    + '<p style="margin:0;color:#aaa">Quit and start it again. If it stops in the same place, the '
    + 'log beside this message (bookforge.log) has the whole of it.</p>'
    + '</body></html>';
}
