#!/usr/bin/env node
/**
 * A BACKTICK INSIDE AN ANGULAR TEMPLATE OR STYLES BLOCK ENDS THE STRING.
 *
 *   node tools/test-no-backticks-in-templates.js
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `template:` and `styles: [...]` are JavaScript TEMPLATE LITERALS. A backtick
 * anywhere inside one terminates it — including inside a comment, where it
 * looks completely inert. What follows is then parsed as code, so the failure
 * is never "your comment is wrong": it is thirty syntax errors somewhere else
 * in the file, or, far worse, a component that compiles into something nobody
 * wrote.
 *
 * It is a natural thing to type, because every OTHER comment in this codebase
 * quotes identifiers in backticks — and that habit is exactly what makes it
 * recur. It happened THREE TIMES on 2026-09-17 alone: twice in an HTML comment
 * in `ai-setup-wizard.component.ts` and `ai-panel.component.ts`, and once in a
 * CSS comment inside `styles: [...]` in the same panel, each time costing a
 * broken build and a hunt through errors pointing at unrelated lines.
 *
 * ── What is checked, and what is deliberately not ───────────────────────────
 *
 * Two regions, both of which can only occur inside a template literal:
 *
 *   1. HTML comments (`<!-- … -->`). A `.component.ts` has nowhere else to put
 *      one.
 *   2. Block comments between `styles: [` and its closing `]`.
 *
 * A backtick in a comment in the CLASS BODY is fine and there are dozens of
 * them; they are ordinary source, not string contents. Checking those would
 * make this test fire on correct code, and a test that cries wolf gets deleted.
 *
 * This is a LEXICAL check on purpose. Parsing the file to find the true extent
 * of each literal is circular — a stray backtick is precisely what moves the
 * end of the literal — so the reliable signal is the one region that cannot
 * legally contain the character at all.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
let failed = 0;
let checked = 0;

function componentFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { componentFiles(full, out); continue; }
    if (entry.name.endsWith('.component.ts')) out.push(full);
  }
  return out;
}

/** The text between `styles: [` and its matching `]`, or '' when there is none. */
function stylesRegion(src) {
  const at = src.indexOf('styles: [');
  if (at === -1) return '';
  let depth = 0;
  for (let i = at + 'styles: ['.length - 1; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i);
    }
  }
  return src.slice(at);
}

for (const file of componentFiles(path.join(REPO, 'src', 'app'))) {
  const src = fs.readFileSync(file, 'utf-8');
  const where = path.relative(REPO, file).replace(/\\/g, '/');
  checked += 1;

  for (const match of src.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (match[1].includes('`')) {
      failed += 1;
      const line = src.slice(0, match.index).split('\n').length;
      console.error(`  FAIL ${where}:${line} — a backtick inside an HTML comment. It ends the `
        + 'template literal; the errors will point somewhere else entirely.');
    }
  }

  for (const match of stylesRegion(src).matchAll(/\/\*([\s\S]*?)\*\//g)) {
    if (match[1].includes('`')) {
      failed += 1;
      console.error(`  FAIL ${where} — a backtick inside a CSS comment in styles: [...]. `
        + 'It ends the template literal.');
    }
  }
}

console.log(`${checked} component files scanned`);
if (failed > 0) {
  console.error(`\nno backticks in templates: ${failed} failing`);
  process.exit(1);
}
/*
 * THE NO-OP GUARD. A walker whose glob stops matching would "pass" forever by
 * scanning nothing, which is the way a keeper dies quietly. The floor is well
 * under the real count (180-odd at the time of writing) so ordinary deletions
 * never trip it, and a restructure that hides every component does.
 */
assert.ok(checked > 50,
  `only ${checked} component files were found, which means the walk is broken rather than the `
  + 'codebase being small. Fix the walk before trusting a pass.');
console.log('no backticks in templates: all clear');
