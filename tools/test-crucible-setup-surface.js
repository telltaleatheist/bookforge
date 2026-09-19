#!/usr/bin/env node
/**
 * THE SETUP SURFACE SHOWS NOBODY A TOKEN AND NOBODY A COMMAND.
 *
 *   node tools/test-crucible-setup-surface.js
 *
 * Derived from crucible `docs/PHASE19-AUTOMATIC-WSL.md` §4, so a control this
 * phase deleted fails BY NAME if it comes back. Two rulings are behind it, both
 * Owen's, both 2026-09-18:
 *
 *   *"we removed tokens. this system is supposed to work like ollama, which
 *   doesn't require a token request/approval to connect. its protection is the
 *   system firewall."*
 *
 *   *"this should be idiot proof. we should assume the user doesn't know how to
 *   do it, and we shouldn't offer to let them do it themselves … we should
 *   assume they have no idea how to do it and it should do it automatically."*
 *
 * What went, and what each string here is the fingerprint of:
 *
 *   `Access key`                 the operator triple's third field, in the
 *                                doors component and in the servers panel.
 *   `Paste a connect code`       the `crucible://` paste box.
 *   `crucible://name@host`       its placeholder, and the "Copy connect code"
 *                                line's own shape.
 *   `Advanced manual connection` the servers panel's disclosure holding both.
 *   `Copy connect code`          the per-row button that put a token on the
 *                                clipboard.
 *   `Enable WSL acceleration`    the engine-controls button that offered a
 *                                choice the orchestrator now makes itself.
 *   `Show what it does`          the disclosure that unfolded into the printed
 *                                step list and "Commands BookForge cannot run
 *                                for you".
 *   `irm https://`               the one-line PowerShell installer, which is a
 *                                command and therefore never shown.
 *
 * ── WHAT IT SCANS, AND WHY THAT IS THE HONEST PLACE ─────────────────────────
 *
 * `dist/renderer` — the BUILT bundle, not the source. A string can reach a
 * screen from a template, a TypeScript literal or a constant three files away,
 * and only the bundle has all three in it. It is also the one artefact that
 * proves `ng build` was run: Angular templates are compiled, so `npx tsc`
 * alone would pass over a template that still draws a deleted field (memory
 * `angular-templates-need-ng-build`).
 *
 * `dist/renderer` IS BOOKFORGE'S OWN BUNDLE AND ONLY ITS OWN. `angular.json`'s
 * default project outputs there; `bookshelf-app` and `clipforge-app` go to
 * `dist/electron/*-ui`, and the VENDORED FOUNDRY (`foundry-app/`) is built and
 * shipped separately and does not land here — measured 2026-09-19, when
 * `irm https://` was already absent from `dist/renderer` while Foundry's
 * vendored `crucible-install.ts` still carried it. That matters because
 * PHASE19 §6 rules that **Foundry lands in BookForge only by re-vendor**:
 * `foundry-app/VENDORED.md` forbids editing it here, so the day a vendored
 * Foundry string does reach this bundle, the fix is to re-vendor at the sha
 * where Foundry's own branch fixed it — never to edit `foundry-app/` and never
 * to add an exception to this list.
 *
 * ── THE COMMENT EXEMPTION THAT ISN'T ────────────────────────────────────────
 *
 * Every deletion in this phase left a comment in the source SAYING what went
 * and why. Comments are stripped by the bundler, so they cost this scan
 * nothing — which is the point of scanning the bundle rather than the source.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BUNDLE = path.join(REPO, 'dist', 'renderer');

/**
 * THE FORBIDDEN STRINGS, each with the control it is the fingerprint of.
 *
 * Verbatim and case-sensitive: a scan that lower-cased both sides would fail
 * on prose that happens to mention an access key, and a keeper that cries wolf
 * is one somebody switches off.
 */
const FORBIDDEN = [
  ['Access key', 'the operator triple\'s access-key field (PHASE19 §4)'],
  ['Paste a connect code', 'the crucible:// paste box (PHASE19 §3)'],
  ['crucible://name@host', 'a connect-code placeholder or a copied connect line (PHASE19 §0)'],
  ['Enable WSL acceleration', 'the WSL opt-in button; the move is automatic now (PHASE19 §4)'],
  ['irm https://', 'a PowerShell install command shown to a person (PHASE19 §0)'],
  ['Show what it does', 'the printed step list disclosure (PHASE19 §4)'],
  ['Copy connect code', 'the per-row button that copied a token (PHASE19 §3)'],
  ['Advanced manual connection', 'the servers panel\'s manual add (PHASE19 §4)'],
];

/** Every file under a directory, depth first. */
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Which files in the bundle carry this string.
 *
 * Read as latin1 so that a byte sequence is compared rather than a decoded
 * one: the bundle is UTF-8 and every string here is ASCII, and a decode that
 * threw on a stray byte would turn a scan into an outage.
 */
function carriers(files, needle) {
  return files
    .filter((file) => fs.readFileSync(file, 'latin1').includes(needle))
    .map((file) => path.relative(REPO, file));
}

if (!fs.existsSync(BUNDLE)) {
  console.error(
    `FAIL — ${path.relative(REPO, BUNDLE)} does not exist. This suite scans the BUILT renderer, `
    + 'because Angular templates are compiled and a deleted field can only be proved gone from '
    + 'the bundle. Run `npx ng build` first.',
  );
  process.exit(1);
}

const files = filesUnder(BUNDLE);
if (files.length === 0) {
  console.error(`FAIL — ${path.relative(REPO, BUNDLE)} is empty; there is nothing to scan.`);
  process.exit(1);
}

console.log(`setup surface — ${files.length} files under ${path.relative(REPO, BUNDLE)}`);

let failed = 0;
for (const [needle, what] of FORBIDDEN) {
  const found = carriers(files, needle);
  if (found.length === 0) {
    console.log(`  ok  "${needle}" is gone — ${what}`);
    continue;
  }
  failed += 1;
  console.error(`  FAIL  "${needle}" is back in the renderer — ${what}`);
  for (const file of found) console.error(`          ${file}`);
}

if (failed > 0) {
  console.error(
    `\nFAIL — ${failed} of ${FORBIDDEN.length} deleted controls are on screen again.\n`
    + 'PHASE19 §0: nobody is ever shown a token, and nobody is ever shown a command. If the\n'
    + 'carrier is the vendored Foundry, the fix is a re-vendor at the sha where Foundry\'s own\n'
    + 'branch removed it (PHASE19 §6) — never an edit under foundry-app/ and never an entry\n'
    + 'removed from the list above.',
  );
  process.exit(1);
}

console.log(`\nPASS — ${FORBIDDEN.length} checks`);
