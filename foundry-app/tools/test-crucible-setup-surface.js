#!/usr/bin/env node
/*
 * test-crucible-setup-surface — the six strings PHASE19 deleted, kept deleted.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §0 makes two rules absolute:
 *
 *   *"Nobody is ever shown a command. Not `irm … | iex`, not `wsl --install`,
 *   not `loginctl`. A command a person could run is a step the app should be
 *   running."*
 *
 *   *"Nobody is ever shown a token, and no app has a field for one … Every
 *   remaining 'access key', 'connect code', 'paste' and 'approve this code'
 *   surface in either app is deleted by this phase."*
 *
 * Those are rules about a SCREEN, and a rule about a screen is not kept by a
 * type. This reads what Angular actually shipped and fails on any of the six
 * strings §4's keeper names, over Foundry's renderer output rather than
 * BookForge's — §5: *"the same surface test as 4, over Foundry's renderer
 * output."*
 *
 * ── WHY THE BUILT RENDERER AND NOT THE SOURCE ─────────────────────────────
 *
 * Because a string can arrive in the bundle from somewhere nobody thought to
 * grep: a vendored component, a constant composed at build time, a template
 * that reads a label out of a shared file. `dist/renderer` is what a person
 * can actually read on their screen, and it is the only artefact that answers
 * the question this keeper asks. It is also why this runs AFTER `ng build`
 * rather than beside `test-no-backticks-in-templates`, which is a source rule.
 *
 * A missing `dist/renderer` is a FAILURE and not a skip. A keeper that passes
 * when there is nothing to check is a keeper that passes forever the first
 * time somebody reorders the build.
 *
 * ── THE SIX, AND WHERE EACH ONE LIVED ─────────────────────────────────────
 *
 *   `irm https://`                  the channel's install line, printed under
 *                                   the install door's first step
 *   `install.ps1`                   the Windows installer, named in the copy
 *                                   above that list
 *   `Set up WSL acceleration`       the button on the wizard's engine card and
 *                                   on Settings › AI
 *   `Nothing is installed without you`  the install door's own subtitle, which
 *                                   promised a sequence a person performs
 *   `Access key`                    the token field, deleted 2026-09-17 and
 *                                   nailed down here
 *   `Paste a connect code`          the pasted pairing line, same
 *
 * The last two were already gone when this was written and are in the list
 * anyway: §0 names them, and a keeper that only guards what broke today is a
 * keeper that has to be rewritten every time something else breaks.
 *
 * `install.sh` is NOT in the list, deliberately. §5 deletes the Mac copy that
 * named it, but the two words are a plausible substring of a minified bundle's
 * unrelated content and a keeper that cries wolf gets deleted. The sentence
 * that carried it is gone with the block, and `Nothing is installed without
 * you` guards the same block.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'dist', 'renderer');

/** Every string that must not be readable on any Foundry screen. */
const FORBIDDEN = [
  'irm https://',
  'install.ps1',
  'Set up WSL acceleration',
  'Nothing is installed without you',
  'Access key',
  'Paste a connect code',
];

/** Every file under a directory, without a glob dependency. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!fs.existsSync(RENDERER)) {
  console.error(
    `${RENDERER} does not exist. This keeper reads what Angular shipped, so it has to run `
    + 'after ng build — there is nothing here to check and that is a failure, not a pass.',
  );
  process.exit(1);
}

/*
 * TEXT FILES ONLY, and by extension rather than by sniffing: the bundle is
 * .js, .css and .html, and reading a font or an image in as UTF-8 would look
 * for English in bytes that have none.
 *
 * `.map` IS DELIBERATELY NOT IN THE LIST. A source map embeds the TypeScript
 * verbatim, comments and all, and several of these files carry long comments
 * explaining which string was deleted and why — which is the documentation
 * this phase asked for, and which no person can read on a screen. A keeper
 * that failed on its own rationale would be a keeper that teaches people to
 * stop writing the rationale down.
 */
const TEXT = ['.js', '.mjs', '.css', '.html'];
const files = walk(RENDERER).filter((file) => TEXT.includes(path.extname(file)));

let bad = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (!text.includes(needle)) continue;
    console.error(
      `${path.relative(RENDERER, file)}: the renderer carries ${JSON.stringify(needle)}. `
      + 'crucible PHASE19 §0: no app shows a command, a token, an access key or a connect '
      + 'code, and no button offers to set up WSL.',
    );
    bad += 1;
  }
}

if (bad > 0) {
  console.error(`\n${bad} forbidden string(s) in the built renderer.`);
  process.exit(1);
}
console.log(
  `no forbidden setup-surface strings in ${files.length} built renderer file(s) `
  + `(${FORBIDDEN.length} checked)`,
);
