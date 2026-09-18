#!/usr/bin/env node
/*
 * test-no-backticks-in-templates — the trap that bit six times in one evening.
 *
 * ── WHAT IT CATCHES ───────────────────────────────────────────────────────
 *
 * An Angular component's `template:` and `styles:` are TEMPLATE LITERALS, so a
 * backtick anywhere inside one ends the string. Nothing about the error says
 * so: the parser runs on until it finds something that cannot be code and then
 * reports it, which is typically two hundred lines away in an unrelated
 * declaration. On 2026-09-17 this produced, in order, "Cannot find name 'auth'",
 * "'open_pairing' does not exist in type 'Component'", "No value exists in scope
 * for the shorthand property 'hostabilityOf'" and "has no exported member
 * 'SetupWizardComponent'" — four hunts, none of which pointed at the backtick.
 *
 * The habit that causes it is markdown: writing `someIdentifier` in a comment,
 * which is right everywhere else in this codebase and fatal in these two
 * strings. Several component files already carry a hand-written warning about
 * it ("NO BACKTICKS ANYWHERE IN THIS TEMPLATE, not even in a comment"), which is
 * the documentation of a rule nothing enforced.
 *
 * Owen approved this keeper on 2026-09-17, asked for rather than assumed: the
 * house rule here is that tests are not written unprompted.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not parse TypeScript. It finds `template:` / `styles: [` openers and
 * walks to the matching close, which is enough because the thing being looked
 * for is a character that MUST NOT appear in that range at all. A file where the
 * walk cannot find a close is REPORTED rather than skipped — an unterminated
 * literal is the very failure this exists for, so silence there would be the
 * keeper failing in exactly the case that matters.
 *
 * Interpolation (${...}) is not special: none of these templates uses it, and a
 * backtick inside one would still be a backtick inside the literal.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');

/** Every .ts under src/, without pulling in a glob dependency. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const OPENERS = ['  template: `', '  styles: [`', '  styles: `'];

/**
 * WHERE THE LITERAL ACTUALLY ENDS, AND WHETHER THAT IS WHERE IT SHOULD.
 *
 * The first UNESCAPED backtick after the opener closes the string — that is not
 * a heuristic, it is what the language does. So the test is not "count the
 * backticks inside" (there cannot be any, by definition); it is: does the
 * closer land somewhere a closer belongs? A real one is immediately followed by
 * `,` or `],`. A stray one is followed by prose, and that is the whole check.
 *
 * ── ESCAPED BACKTICKS ARE FINE AND THIS TREE USES THEM ────────────────────
 *
 * `\\\`QueueBarComponent\\\`` appears inside app.ts's template comment quite
 * legitimately. The first draft of this keeper counted raw backticks and
 * reported 38 files on a tree that compiles — which was the keeper being wrong,
 * not the code, and is why the skip below exists.
 */
function closerOf(text, from) {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === '\\') { at += 1; continue; }
    if (text[at] !== '`') continue;
    const after = text.slice(at + 1, at + 3);
    const ok = after.startsWith(',') || after.startsWith('],');
    return { at, ok, line: text.slice(0, at).split('\n').length };
  }
  return null;
}

let bad = 0;
let scanned = 0;
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const opener of OPENERS) {
    let at = text.indexOf(opener);
    while (at !== -1) {
      scanned += 1;
      const from = at + opener.length;
      const closer = closerOf(text, from);
      if (closer === null) {
        console.error(
          `${path.relative(ROOT, file)}: a ${opener.trim()} literal is never closed.`,
        );
        bad += 1;
      } else if (!closer.ok) {
        console.error(
          `${path.relative(ROOT, file)}:${closer.line}: this backtick closes a `
          + `${opener.trim()} literal in the middle of it. A backtick ends the string, so the `
          + 'compiler will blame a line nowhere near here. Escape it (\\`) or use quotes.',
        );
        bad += 1;
      }
      at = text.indexOf(opener, from);
    }
  }
}

if (bad > 0) {
  console.error(`\n${bad} inline literal(s) carry a stray backtick.`);
  process.exit(1);
}
console.log(`no stray backticks in ${scanned} inline template/styles literals`);
