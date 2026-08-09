#!/usr/bin/env node
/**
 * quire-paginate — stamp an EPUB, paginate it, print what happened.
 *
 *   npm run build:electron            (or: npx tsc -p tsconfig.electron.json)
 *   node tools/quire-paginate.js <book.epub> [--width 600] [--height 900]
 *                                            [--font-size 18] [--gap 24]
 *                                            [--json out.json] [--keep-stamped]
 *                                            [--png <page> <file.png>]
 *
 * It re-launches itself under Electron, because quire paginates in a real
 * browser and there is no browser in plain Node. That is the point of the
 * package, so the harness makes it obvious rather than hiding it.
 *
 * The run is the whole path a caller would take: BookForge's own enumeration
 * stamps the book (electron/quire-stamp.ts), quire paginates the stamped copy,
 * and the id → page map is printed. Nothing is inferred from geometry anywhere.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

// ── Re-launch under Electron if we are not already there ──────────────────
if (!process.versions.electron) {
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { app } = require('electron');
const { Quire } = require(path.join(__dirname, '..', 'dist', 'packages', 'quire', 'src', 'index.js'));
const { stampEpubForQuire } = require(path.join(__dirname, '..', 'dist', 'electron', 'quire-stamp.js'));

// The scheme must be privileged before the app is ready — the same constraint
// bookforge-page is under in electron/main.ts.
Quire.registerScheme();

// quire's analysis window is a real BrowserWindow, so destroying it can leave
// the app with none — and Electron's default reaction to that is to quit. In
// BookForge the main window keeps the app alive; in a headless harness nothing
// does, so the default is turned off explicitly.
app.on('window-all-closed', () => { /* the harness decides when it is done */ });

function parseArgs(argv) {
  const args = {
    epub: null, width: 600, height: 900, fontSize: 18, gap: undefined,
    json: null, keepStamped: false, png: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--width': args.width = Number(argv[++i]); break;
      case '--height': args.height = Number(argv[++i]); break;
      case '--font-size': args.fontSize = Number(argv[++i]); break;
      case '--gap': args.gap = Number(argv[++i]); break;
      case '--json': args.json = argv[++i]; break;
      case '--keep-stamped': args.keepStamped = true; break;
      case '--png': args.png = { page: Number(argv[++i]), file: argv[++i] }; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        if (args.epub) throw new Error(`more than one EPUB given: ${args.epub} and ${a}`);
        args.epub = a;
    }
  }
  if (!args.epub) throw new Error('usage: node tools/quire-paginate.js <book.epub> [options]');
  return args;
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const epub = path.resolve(args.epub);
  if (!fs.existsSync(epub)) throw new Error(`no such file: ${epub}`);

  const stampedPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'quire-')), `${path.basename(epub, '.epub')}.stamped.epub`);

  console.log(`book        ${epub}`);
  console.log(`geometry    ${args.width}x${args.height}, font-size ${args.fontSize}`
    + `${args.gap === undefined ? ' (gutter: package default)' : `, gutter ${args.gap}`}`);
  console.log('');

  // ── 1. Stamp, with BookForge's own enumeration ──────────────────────────
  const stampStarted = Date.now();
  const stamp = await stampEpubForQuire(epub, stampedPath, path.basename(epub));
  const stampMs = Date.now() - stampStarted;
  console.log('── stamping (electron/quire-stamp.ts) ──');
  console.log(`documents         ${stamp.documents.length}`);
  console.log(`text units        ${stamp.textUnitCount}`);
  console.log(`image elements    ${stamp.imageElementCount}`);
  console.log(`stamps written    ${stamp.stamped.length}`);
  if (stamp.sharedElements.length > 0) {
    console.log(`shared elements   ${stamp.sharedElements.length} (one element, several keys)`);
    for (const s of stamp.sharedElements.slice(0, 10)) {
      console.log(`                  <${s.tag}> ${s.keys.join(' + ')}`);
    }
  }
  console.log(`took              ${fmtMs(stampMs)}`);
  console.log('');

  // ── 2. Paginate ────────────────────────────────────────────────────────
  const layoutOptions = { width: args.width, height: args.height, fontSize: args.fontSize };
  if (args.gap !== undefined) layoutOptions.gap = args.gap;

  const doc = await Quire.openDocument(stampedPath);
  let report;
  try {
    const started = Date.now();
    report = await doc.layout(layoutOptions);
    const wall = Date.now() - started;

    console.log('── pagination (packages/quire) ──');
    console.log(`pages             ${doc.countPages()}`);
    console.log(`wall clock        ${fmtMs(wall)} (layout() reported ${fmtMs(report.layoutMs)})`);
    console.log(`documents walked  ${report.documents.length}`);
    console.log(`stamps seen       ${report.stampedIds.length}`);
    console.log(`STAMPS WITH NO PAGE  ${report.unplaced.length}`);
    console.log('');

    if (report.spineWarnings.length > 0) {
      console.log('── spine itemrefs that yielded no document ──');
      for (const w of report.spineWarnings) console.log(`  ${w.idref}: ${w.reason}`);
      console.log('');
    }

    if (report.unplaced.length > 0) {
      console.log('── stamps with no page (every one named) ──');
      const byReason = new Map();
      for (const u of report.unplaced) {
        const k = `display:${u.display}, text:${u.hasText ? 'yes' : 'no'}, <${u.tag}>`;
        byReason.set(k, (byReason.get(k) ?? 0) + 1);
      }
      for (const [k, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(5)}  ${k}`);
      }
      console.log('  first 20:');
      for (const u of report.unplaced.slice(0, 20)) {
        console.log(`    ${u.id}  <${u.tag}> display:${u.display} text:${u.hasText}`);
      }
      console.log('');
    }

    if (report.overflows.length > 0) {
      console.log(`── fragments running past their column's right edge: ${report.overflows.length} ──`);
      for (const o of report.overflows.slice(0, 10)) {
        console.log(`  ${o.id} page ${o.page} by ${o.overshoot}px`);
      }
      console.log('');
    }

    // ── per-page block counts ───────────────────────────────────────────
    const pageCount = doc.countPages();
    const perPage = [];
    const idPages = new Map();
    const splits = [];
    const images = [];
    for (let p = 0; p < pageCount; p++) {
      const blocks = doc.loadPage(p).getBlocks();
      perPage.push(blocks.length);
      for (const b of blocks) {
        const list = idPages.get(b.id);
        if (list) list.push(p); else idPages.set(b.id, [p]);
        if (b.splitFrom !== null && b.splitTo !== null && b.page !== undefined) { /* noop */ }
        if (b.type === 'image') images.push({ id: b.id, page: p, bbox: b.bbox, splitFrom: b.splitFrom, splitTo: b.splitTo });
      }
    }
    for (const [id, pages] of idPages) {
      if (pages.length > 1) splits.push({ id, from: Math.min(...pages), to: Math.max(...pages) });
    }

    console.log('── blocks per page ──');
    const line = [];
    for (let p = 0; p < pageCount; p++) line.push(`${p}:${perPage[p]}`);
    console.log(`  ${line.join('  ')}`);
    console.log(`  total blocks ${perPage.reduce((a, b) => a + b, 0)}`
      + `, empty pages ${perPage.filter((n) => n === 0).length}`);
    console.log('');

    console.log(`── elements spanning a page break: ${splits.length} ──`);
    for (const s of splits.slice(0, 25)) console.log(`  ${s.id}  pages ${s.from}..${s.to}`);
    if (splits.length > 25) console.log(`  … and ${splits.length - 25} more`);
    console.log('');

    console.log(`── image blocks: ${images.length} ──`);
    for (const im of images) {
      const span = im.splitFrom === null ? '' : `  (split ${im.splitFrom}..${im.splitTo})`;
      console.log(`  ${im.id}  page ${im.page}  `
        + `[${im.bbox.x.toFixed(0)},${im.bbox.y.toFixed(0)} ${im.bbox.w.toFixed(0)}x${im.bbox.h.toFixed(0)}]${span}`);
    }
    console.log('');

    console.log('── id → page map ──');
    for (const s of stamp.stamped) {
      const pages = idPages.get(s.key);
      console.log(`  ${s.key}\t${pages ? pages.join(',') : 'NO PAGE'}`);
    }
    console.log('');

    // ── sandbox observations ────────────────────────────────────────────
    console.log('── sandbox ──');
    console.log(`requests refused by the session: ${doc.refusals.length}`);
    for (const r of doc.refusals.slice(0, 10)) console.log(`  ${r.url} — ${r.reason}`);
    const csp = doc.consoleMessages.filter((m) => /Content Security Policy/i.test(m));
    console.log(`CSP violations reported by the book: ${csp.length}`);
    for (const m of csp.slice(0, 5)) console.log(`  ${m.split('\n')[0]}`);
    console.log('');

    if (args.png) {
      const buf = await doc.loadPage(args.png.page).toPng(1);
      fs.writeFileSync(args.png.file, buf);
      console.log(`wrote ${args.png.file} (${buf.length} bytes) for page ${args.png.page}`);
    }

    if (args.json) {
      const payload = {
        book: epub,
        geometry: layoutOptions,
        pages: pageCount,
        layoutMs: report.layoutMs,
        documents: report.documents,
        documentPageOffsets: report.documentPageOffsets,
        blocksPerPage: perPage,
        unplaced: report.unplaced,
        overflows: report.overflows,
        splits,
        images,
        idToPages: Object.fromEntries(idPages),
        stampedOrder: stamp.stamped.map((s) => s.key),
      };
      fs.writeFileSync(args.json, JSON.stringify(payload, null, 2));
      console.log(`wrote ${args.json}`);
    }
  } finally {
    await doc.close();
    if (!args.keepStamped) {
      fs.rmSync(path.dirname(stampedPath), { recursive: true, force: true });
    } else {
      console.log(`stamped copy kept at ${stampedPath}`);
    }
  }
}

app.whenReady()
  .then(main)
  .then(() => { app.exit(0); })
  .catch((err) => {
    console.error('');
    console.error(err && err.stack ? err.stack : String(err));
    app.exit(1);
  });
