#!/usr/bin/env node
/**
 * Which surface shows a quire page to the user? — measured, not preferred.
 *
 *   npx tsc -p tsconfig.electron.json && npm run build:quire-vendor
 *   node tools/probe-quire-host.js <book.epub> [--json out.json]
 *
 * Re-launches itself under Electron, like every other quire harness, because a
 * display surface only exists inside a browser.
 *
 * The viewer plan named two candidate hosts and said to decide by measurement.
 * Reading the code turned two into four, and running them turned up a fifth
 * question that decides more than the other four together:
 *
 *   A. `<webview>` per PAGE — what `packages/quire/src/mount.ts` does today.
 *   B. `<webview>` per SPINE DOCUMENT, its page boxes arranged into a grid
 *      inside the frame — what the package README says a grid "should" do.
 *   C. `WebContentsView` overlay positioned over the app window.
 *   D. plain `<iframe src="quire://…">` in the app's own renderer — the plan's
 *      candidate (a). Probed to find out what actually happens to it.
 *   V. VISIBILITY. Under `fragmented-boxes` the page boxes are built IN the
 *      frame by Paged.js, whose work queue ticks on `requestAnimationFrame`.
 *      The README already records that a hidden ANALYSIS window paginates 47×
 *      slower. A virtualised grid mounts cells the user has not scrolled to
 *      yet, so the same trap is waiting on the DISPLAY side, and V measures
 *      exactly where it bites: fully visible, half visible, below the fold,
 *      `visibility:hidden`, `display:none`.
 *
 * Evidence goes to --json; nothing is written to the repo.
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
  const electron = require(path.join(__dirname, '..', 'node_modules', 'electron'));
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  // stdio: 'inherit' — the child writes straight to this process's own stdout/
  // stderr fds, so nothing here is buffered and there is nothing to drain.
  process.exitCode = result.status === null ? 1 : result.status;
  return;
}

const electronApi = require('electron');
const { app, BrowserWindow, BrowserView, WebContentsView } = electronApi;
const DIST = path.join(__dirname, '..', 'dist');
const { Quire, AttachedWebContentsHost } = require(path.join(DIST, 'packages/quire/src/index.js'));
const { stampEpubForQuire } = require(path.join(DIST, 'electron/quire-stamp.js'));

// Module scope, before app.whenReady() — the scheme is privileged and Chromium
// accepts that registration only before the app is up.
Quire.registerScheme();

// ── arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(process.argv.indexOf(__filename) + 1);
let bookPath = null;
let jsonOut = null;
let only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') { jsonOut = argv[++i]; continue; }
  if (argv[i] === '--only') { only = argv[++i].split(',').map((s) => s.trim().toUpperCase()); continue; }
  if (!bookPath) bookPath = argv[i];
}
/** Which probes to run this time. All of them unless --only says otherwise. */
const runs = (letter) => only === null || only.includes(letter);
if (!bookPath) {
  console.error('usage: node tools/probe-quire-host.js <book.epub> [--json out.json]');
  process.exitCode = 2;
  return;
}

const GEOMETRY = { width: 600, height: 900, fontSize: 18 };
const WINDOW_PAGES = 12;      // the mounted set a virtualised grid holds
const GRID_COLUMNS = 4;
const GRID_GAP = 24;
const SCROLL_FRAMES = 120;
const VISIBILITY_REPEATS = 2;

const results = { book: path.basename(bookPath), geometry: GEOMETRY, probes: {} };
const fails = [];
const verbose = !!process.env.QUIRE_PROBE_VERBOSE;

const ms = (n) => Math.round(n * 10) / 10;
const pct = (sorted, p) => (sorted.length === 0 ? null
  : ms(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]));
const median = (xs) => pct([...xs].sort((a, b) => a - b), 50);

// ── the host window ─────────────────────────────────────────────────────────
//
// A stand-in for the Angular window: `webviewTag: true` (the real one already
// has it — electron/main.ts:806) and a scrollable container the pages go in.

const HOST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>quire host probe</title>
<style>
  html,body{margin:0;padding:0;background:#1b1b1b;height:100%;overflow:hidden}
  #scroller{position:absolute;inset:0;overflow:auto}
  #grid{display:flex;flex-wrap:wrap;align-content:flex-start;gap:${GRID_GAP}px;padding:${GRID_GAP}px}
  webview{display:block;border:0;background:#fff}
  .cell{background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.5)}
</style>
<div id="scroller"><div id="grid"></div></div>
`;

async function makeHostWindow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-host-probe-'));
  const file = path.join(dir, 'host.html');
  fs.writeFileSync(file, HOST_HTML, 'utf8');
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    // Never occluded. Chromium throttles rAF for a window another window covers,
    // and Paged.js's work queue ticks on rAF — so an occluded probe window would
    // measure the desktop's window stacking rather than the host under test.
    // (That throttle is a real product hazard too; V_windowOccluded measures it.)
    alwaysOnTop: true,
    webPreferences: {
      webviewTag: true,        // as electron/main.ts already sets for the app window
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // the HOST page is ours; the BOOK's frames are sandboxed
    },
  });
  win.webContents.on('console-message', (_e, _level, message) => {
    if (verbose) console.log(`[host] ${message}`);
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
  await win.loadFile(file);
  return { win, dir };
}

/**
 * Run an expression in the host page and get its value back.
 *
 * Every call is bounded and named. A surface that never answers is itself a
 * result — "this host cannot show this page" — and a probe that hung instead of
 * saying so would report nothing at all.
 */
function inHost(win, expression, label = 'host script', timeoutMs = 60000) {
  const t0 = Date.now();
  return Promise.race([
    win.webContents.executeJavaScript(expression, true),
    new Promise((_r, reject) => setTimeout(
      () => reject(new Error(`${label}: no answer within ${timeoutMs} ms`)), timeoutMs)),
  ]).then((value) => {
    if (verbose) console.log(`[probe]   ${label}: ${Date.now() - t0} ms`);
    return value;
  });
}

// ── the code the host page runs ─────────────────────────────────────────────
//
// Written here as source text rather than as a file the probe loads, so what
// was measured is visible beside the numbers it produced.

const HOST_BOOTSTRAP = `(() => {
  const grid = document.getElementById('grid');
  const scroller = document.getElementById('scroller');
  const mounted = [];
  const pending = new Map();
  const record = new Map();
  let nextMount = 1;

  /**
   * A frame, and the promise that it is showing something.
   *
   * A webview that never finishes loading is bounded here rather than left to
   * the caller's timeout, so the failure names the URL.
   */
  function makeFrame(url, partition, w, h, placement) {
    const frame = document.createElement('webview');
    frame.setAttribute('src', url);
    frame.setAttribute('partition', partition);
    frame.setAttribute('webpreferences',
      'sandbox=yes,contextIsolation=yes,nodeIntegration=no,webSecurity=yes,'
      + 'allowRunningInsecureContent=no,experimentalFeatures=no,webviewTag=no');
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (placement) cell.style.cssText = placement;
    cell.appendChild(frame);
    grid.appendChild(cell);
    const ready = new Promise((resolve, reject) => {
      frame.addEventListener('did-finish-load', () => resolve());
      frame.addEventListener('did-fail-load', (e) => reject(new Error(
        'did-fail-load ' + e.errorCode + ' ' + e.errorDescription + ' for ' + url)));
      setTimeout(() => reject(new Error('frame never finished loading ' + url)), 30000);
    });
    mounted.push({ frame, cell });
    return { frame, cell, ready };
  }

  async function evalIn(frame, code) {
    const raw = await frame.executeJavaScript(code);
    const parsed = JSON.parse(String(raw));
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  /**
   * Lay one document's page boxes into a grid, then measure.
   *
   * quire's layout CSS pins \`.pagedjs_pages{display:block!important}\`, so the
   * override has to carry !important too — a grid that quietly stayed a block
   * would look like a one-column viewer rather than like an error.
   *
   * Every rect is read AFTER the arrangement. A re-parented page box is not
   * pixel-stable, so a rect measured before the move would be a confident wrong
   * answer (gate G0).
   */
  function ARRANGE(columns, gap, scale) {
    return '(function(){try{'
      + 'var c=document.querySelector(".pagedjs_pages");'
      + 'if(!c) return JSON.stringify({error:"no .pagedjs_pages container"});'
      + 'c.style.setProperty("display","grid","important");'
      + 'c.style.setProperty("grid-template-columns","repeat(' + columns + ',max-content)","important");'
      + 'c.style.setProperty("gap","' + gap + 'px","important");'
      + 'c.style.setProperty("justify-content","start","important");'
      + 'c.style.transformOrigin="0 0";'
      + 'c.style.transform=' + JSON.stringify(scale === 1 ? '' : 'scale(' + scale + ')') + ';'
      + 'window.scrollTo(0,0);'
      + 'var boxes=document.querySelectorAll(".pagedjs_page");'
      + 'var pages=[];for(var i=0;i<boxes.length;i++){var r=boxes[i].getBoundingClientRect();'
      + 'pages.push({x:+r.left.toFixed(2),y:+r.top.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)});}'
      + 'var els=document.querySelectorAll("[data-quire-id]");var stamps=0;'
      + 'for(var j=0;j<els.length;j++){els[j].getBoundingClientRect();stamps++;}'
      + 'return JSON.stringify({pages:pages,stamps:stamps,nodes:document.getElementsByTagName("*").length});'
      + '}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()';
  }

  window.__probe = {
    /** One page in its own frame: prelude + present, exactly like mountQuirePage. */
    async mountPage(mount, partition, scrollIntoView) {
      const t0 = performance.now();
      const { frame, cell, ready } = makeFrame(
        mount.url, partition, mount.width * mount.scale, mount.height * mount.scale);
      if (scrollIntoView) {
        cell.scrollIntoView();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      await ready;
      const tLoaded = performance.now();
      if (mount.preludeScript) await evalIn(frame, mount.preludeScript);
      const tPrelude = performance.now();
      await evalIn(frame, mount.presentScript);
      const tPresent = performance.now();
      return { load: tLoaded - t0, prelude: tPrelude - tLoaded, present: tPresent - tPrelude,
               total: tPresent - t0 };
    },

    /** One SPINE DOCUMENT in its own frame, its page boxes laid into a grid. */
    async mountDocument(mount, partition, columns, gap, scrollIntoView) {
      const t0 = performance.now();
      const gridW = columns * mount.width + (columns - 1) * gap;
      const rows = Math.ceil(mount.documentPageCount / columns);
      const gridH = rows * mount.height + (rows - 1) * gap;
      console.log('mountDocument ' + mount.document + ' pages=' + mount.documentPageCount);
      const { frame, cell, ready } = makeFrame(
        mount.url, partition, gridW * mount.scale, gridH * mount.scale);
      if (scrollIntoView) {
        cell.scrollIntoView();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      await ready;
      const tLoaded = performance.now();
      if (mount.preludeScript) await evalIn(frame, mount.preludeScript);
      const tPrelude = performance.now();
      await evalIn(frame, mount.presentScript);
      const tPresent = performance.now();
      const arranged = await evalIn(frame, ARRANGE(columns, gap, mount.scale));
      const tArranged = performance.now();
      return {
        load: tLoaded - t0, prelude: tPrelude - tLoaded, present: tPresent - tPrelude,
        arrange: tArranged - tPresent, total: tArranged - t0,
        pages: arranged.pages, stamps: arranged.stamps, nodes: arranged.nodes,
        gridW, gridH,
      };
    },

    /**
     * One document, paginated in a frame placed exactly where the caller says,
     * with everything else torn down first. This is V: the same work, five
     * placements, nothing else in the window to contend with.
     */
    async paginateAt(mount, partition, placement) {
      await window.__probe.teardown();
      scroller.scrollTop = 0;
      const { frame, ready } = makeFrame(
        mount.url, partition, mount.width * mount.scale, mount.height * mount.scale, placement);
      await ready;
      const t0 = performance.now();
      if (mount.preludeScript) await evalIn(frame, mount.preludeScript);
      const tPrelude = performance.now();
      const presented = await evalIn(frame, mount.presentScript);
      const tPresent = performance.now();
      return {
        prelude: tPrelude - t0,
        present: tPresent - tPrelude,
        pages: presented.pages,
        msPerPage: (tPresent - tPrelude) / Math.max(1, presented.pages),
      };
    },

    /**
     * Start a mount and hand back a token instead of awaiting it, so the probe
     * can take the window away in the middle and come back for the answer.
     */
    beginMountDocument(mount, partition, columns, gap) {
      const id = 'm' + (nextMount++);
      const promise = window.__probe.mountDocument(mount, partition, columns, gap, false)
        .then(function (result) { record.set(id, {settled: true, ok: true, result: result}); return record.get(id); },
              function (err) { record.set(id, {settled: true, ok: false, error: String((err && err.message) || err)}); return record.get(id); });
      record.set(id, {settled: false});
      pending.set(id, promise);
      return id;
    },

    mountSettled(id) { return !!(record.get(id) || {}).settled; },

    awaitMount(id) { return pending.get(id); },

    async teardown() {
      const t0 = performance.now();
      for (const m of mounted) m.cell.remove();
      mounted.length = 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    },

    /** Frame times while the container scrolls with whatever is mounted in it. */
    async scroll(frames) {
      const times = [];
      let last = performance.now();
      scroller.scrollTop = 0;
      await new Promise((resolve) => {
        let n = 0;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          scroller.scrollTop += 8;
          if (++n >= frames) { resolve(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      times.shift();
      return times;
    },

    nodeCount() { return document.getElementsByTagName('*').length; },

    /**
     * The plan's candidate (a), asked the only honest way: put the book's URL in
     * an ordinary iframe in the APP's own renderer and see what happens.
     */
    async iframe(url) {
      return await new Promise((resolve) => {
        const f = document.createElement('iframe');
        f.style.cssText = 'width:600px;height:900px;border:0';
        let settled = false;
        const done = (verdict) => { if (!settled) { settled = true; f.remove(); resolve(verdict); } };
        f.addEventListener('load', () => {
          let readable = null;
          try {
            readable = f.contentDocument
              ? (f.contentDocument.body ? 'body present, ' + f.contentDocument.body.childElementCount + ' children' : 'no body')
              : 'contentDocument is null (cross-origin or failed)';
          } catch (e) { readable = 'threw: ' + e.message; }
          done({ loaded: true, contentDocument: readable });
        });
        f.addEventListener('error', () => done({ loaded: false, reason: 'error event' }));
        setTimeout(() => done({ loaded: false, reason: 'no load event within 5000ms' }), 5000);
        f.src = url;
        document.body.appendChild(f);
      });
    },
  };
})()`;

// ── the probes ──────────────────────────────────────────────────────────────

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-host-stamp-'));
  const stampedPath = path.join(tmp, 'stamped.epub');
  console.log(`[probe] stamping ${path.basename(bookPath)} …`);
  const stamp = await stampEpubForQuire(bookPath, stampedPath);
  console.log(`[probe] ${stamp.stamped.length} elements stamped across ${stamp.documents.length} documents`);

  const doc = await Quire.openDocument(stampedPath);
  const report = await doc.layout(GEOMETRY);
  const pageCount = doc.countPages();
  console.log(`[probe] ${pageCount} pages in ${Math.round(report.layoutMs)} ms (${report.unplaced.length} unplaced)`);
  Object.assign(results, {
    pageCount,
    documents: report.documents.length,
    layoutMs: Math.round(report.layoutMs),
    unplaced: report.unplaced.length,
  });

  const partition = `quire-${new URL(doc.getPageMount(0).url).host}`;
  const { win, dir } = await makeHostWindow();
  await inHost(win, HOST_BOOTSTRAP, 'bootstrap');

  const offsets = report.documentPageOffsets;
  const docPageCount = (d) => (d + 1 < offsets.length ? offsets[d + 1] : pageCount) - offsets[d];
  // The biggest document in the first dozen pages — the one whose pagination
  // takes long enough for a throttle to be unmistakable.
  let vDoc = 0;
  for (let d = 0; d < offsets.length && offsets[d] < WINDOW_PAGES * 2; d++) {
    if (docPageCount(d) > docPageCount(vDoc)) vDoc = d;
  }
  const vMount = doc.getPageMount(offsets[vDoc]);
  console.log(`[probe] V uses ${vMount.document} (${vMount.documentPageCount} pages)`);

  // ── A. one webview per page, the 12-page window ───────────────────────────
  for (const scrollIntoView of runs('A') ? [true, false] : []) {
    const perPage = [];
    let refusal = null;
    for (let p = 0; p < WINDOW_PAGES; p++) {
      const mount = doc.getPageMount(p);
      try {
        perPage.push(await inHost(
          win,
          `window.__probe.mountPage(${JSON.stringify(mount)}, ${JSON.stringify(partition)}, ${scrollIntoView})`,
          `A(${scrollIntoView ? 'scrolled to' : 'as-is'}): page ${p}`, 120000));
      } catch (err) { refusal = String(err.message); break; }
    }
    const nodes = await inHost(win, 'window.__probe.nodeCount()', 'A: node count');
    const scroll = (await inHost(win, `window.__probe.scroll(${SCROLL_FRAMES})`, 'A: scroll', 120000))
      .sort((a, b) => a - b);
    const heap = await hostHeapMb(win);
    const teardown = await inHost(win, 'window.__probe.teardown()', 'A: teardown');
    results.probes[scrollIntoView ? 'A_webviewPerPage_scrolledInto' : 'A_webviewPerPage_asIs'] = {
      what: `one <webview> per page (mount.ts as it stands), each cell ${scrollIntoView ? 'scrolled into view before it paginates' : 'left wherever the grid put it'}`,
      pagesMounted: perPage.length,
      refusal,
      firstPageMs: perPage.length ? ms(perPage[0].total) : null,
      firstPageBreakdown: perPage.length
        ? { load: ms(perPage[0].load), prelude: ms(perPage[0].prelude), present: ms(perPage[0].present) }
        : null,
      windowTotalMs: ms(perPage.reduce((s, r) => s + r.total, 0)),
      medianPageMs: perPage.length ? median(perPage.map((r) => r.total)) : null,
      worstPageMs: perPage.length ? ms(Math.max(...perPage.map((r) => r.total))) : null,
      medianPreludeMs: perPage.length ? median(perPage.map((r) => r.prelude)) : null,
      preludeEvaluations: perPage.length,
      hostNodes: nodes,
      hostHeapMb: heap,
      scrollFrameMsP50: pct(scroll, 50),
      scrollFrameMsP95: pct(scroll, 95),
      teardownMs: ms(teardown),
    };
    console.log(`[probe] A (${scrollIntoView ? 'scrolled' : 'as-is'}) done`);
  }

  // ── B. one webview per spine document, page boxes gridded inside it ───────
  if (runs('B')) {
    const docsToCover = [];
    let covered = 0;
    for (let d = 0; d < offsets.length && covered < WINDOW_PAGES; d++) {
      docsToCover.push(offsets[d]);
      covered += docPageCount(d);
    }
    const perDoc = [];
    let refusal = null;
    for (const firstPage of docsToCover) {
      const mount = doc.getPageMount(firstPage);
      try {
        perDoc.push(await inHost(
          win,
          `window.__probe.mountDocument(${JSON.stringify(mount)}, ${JSON.stringify(partition)}, ${GRID_COLUMNS}, ${GRID_GAP}, true)`,
          `B: document at page ${firstPage}`, 120000));
      } catch (err) { refusal = String(err.message); break; }
    }
    const shownPages = perDoc.reduce((s, r) => s + r.pages.length, 0);
    const nodes = await inHost(win, 'window.__probe.nodeCount()', 'B: node count');
    const scroll = (await inHost(win, `window.__probe.scroll(${SCROLL_FRAMES})`, 'B: scroll', 120000))
      .sort((a, b) => a - b);
    const heap = await hostHeapMb(win);
    const teardown = await inHost(win, 'window.__probe.teardown()', 'B: teardown');

    // Did the grid actually place the boxes as a grid? One column would mean the
    // !important override lost, and every number above it would be meaningless.
    const widest = perDoc.reduce((best, r) => (r.pages.length > best.pages.length ? r : best), perDoc[0]);
    results.probes.B_webviewPerDocumentGrid = {
      what: 'one <webview> per spine document, its .pagedjs_page boxes arranged into a grid inside the frame',
      refusal,
      documentsMounted: perDoc.length,
      pagesShown: shownPages,
      firstDocumentMs: perDoc.length ? ms(perDoc[0].total) : null,
      totalMs: ms(perDoc.reduce((s, r) => s + r.total, 0)),
      msPerPageShown: ms(perDoc.reduce((s, r) => s + r.total, 0) / Math.max(1, shownPages)),
      medianArrangeMs: perDoc.length ? median(perDoc.map((r) => r.arrange)) : null,
      preludeEvaluations: perDoc.length,
      gridColumnsObserved: widest ? new Set(widest.pages.map((p) => Math.round(p.x))).size : null,
      gridRowsObserved: widest ? new Set(widest.pages.map((p) => Math.round(p.y))).size : null,
      pagesInWidestDocument: widest ? widest.pages.length : null,
      stampedElementsMeasured: perDoc.reduce((s, r) => s + r.stamps, 0),
      frameNodesFirstDocument: perDoc.length ? perDoc[0].nodes : null,
      hostNodes: nodes,
      hostHeapMb: heap,
      scrollFrameMsP50: pct(scroll, 50),
      scrollFrameMsP95: pct(scroll, 95),
      teardownMs: ms(teardown),
    };
    console.log('[probe] B done');
  }

  // ── C. the native-view overlay ────────────────────────────────────────────
  //
  // The plan named `WebContentsView`. It does not exist here: that class and
  // `BrowserWindow.contentView` arrived in Electron 30 and this app is on
  // 29.x, so the overlay as the plan described it cannot be built today at all —
  // which is a fact about the option, not about the probe. `BrowserView` is the
  // pre-30 spelling of the same native child view, so that is what is measured.
  if (runs('C')) {
    const electronMajor = Number(process.versions.electron.split('.')[0]);
    const OverlayView = electronMajor >= 30 && WebContentsView ? WebContentsView : BrowserView;
    const prefs = {
      session: doc.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    };
    const view = new OverlayView({ webPreferences: prefs });
    const attach = () => {
      if (win.contentView && typeof win.contentView.addChildView === 'function') {
        win.contentView.addChildView(view);
      } else {
        win.addBrowserView(view);
      }
    };
    const detach = () => {
      if (win.contentView && typeof win.contentView.removeChildView === 'function') {
        win.contentView.removeChildView(view);
      } else {
        win.removeBrowserView(view);
      }
    };
    attach();
    view.setBounds({ x: 20, y: 20, width: GEOMETRY.width, height: GEOMETRY.height });

    const tAttach0 = Date.now();
    const host = AttachedWebContentsHost.attach(view.webContents, doc.session);
    await host.load(doc.getPageMount(0).url);
    const tLoaded = Date.now();
    await doc.presentPage(0, host);
    const tPresented = Date.now();

    // A second page in the SAME view: what an overlay does instead of mounting
    // a second surface, and the reason an overlay shows one page at a time.
    const tSecond0 = Date.now();
    await doc.presentPage(1, host);
    const tSecond = Date.now();

    // Following a scrolling grid means re-sending the view's bounds from the
    // renderer every frame. Timed as the round trip it is.
    const boundsTimes = [];
    for (let i = 0; i < SCROLL_FRAMES; i++) {
      const t = process.hrtime.bigint();
      view.setBounds({ x: 20, y: 20 - (i % 60), width: GEOMETRY.width, height: GEOMETRY.height });
      await inHost(win, 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
        'C: frame', 20000);
      boundsTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    boundsTimes.sort((a, b) => a - b);

    // Can an Angular overlay draw ON TOP of it? A native child view is a sibling
    // of the window's own web contents, not an element inside it, so this is a
    // fact about the compositor rather than a z-index to tune. The DOM answers
    // for the point the view covers; the pixels there are not the DOM's.
    const domAtOverlayPoint = await inHost(win, `(() => {
      const el = document.elementFromPoint(25, 25);
      return el ? el.tagName : null;
    })()`, 'C: hit test');

    const tDestroy0 = Date.now();
    host.destroy();
    detach();
    view.webContents.close();
    const tDestroy = Date.now();

    results.probes.C_nativeViewOverlay = {
      what: `a native child view (${OverlayView === WebContentsView ? 'WebContentsView' : 'BrowserView'}) positioned over the app window`,
      electron: process.versions.electron,
      webContentsViewAvailable: electronMajor >= 30 && !!WebContentsView,
      loadMs: tLoaded - tAttach0,
      firstPresentMs: tPresented - tLoaded,
      firstPageMs: tPresented - tAttach0,
      secondPageSameViewMs: tSecond - tSecond0,
      pagesVisibleAtOnce: 1,
      setBoundsRoundTripMsP50: pct(boundsTimes, 50),
      setBoundsRoundTripMsP95: pct(boundsTimes, 95),
      domElementAtOverlayPoint: domAtOverlayPoint,
      angularOverlayCanPaintOverIt: false,
      teardownMs: tDestroy - tDestroy0,
    };
    console.log('[probe] C done');
  }

  // ── D. the plan's iframe, in the app's own renderer ───────────────────────
  if (runs('D')) {
    const url = doc.getPageMount(0).url;
    const verdict = await inHost(win, `window.__probe.iframe(${JSON.stringify(url)})`, 'D: iframe', 30000);
    results.probes.D_iframeInAppRenderer = {
      what: 'an ordinary <iframe src="quire://…"> in the app renderer, whose session has no quire handler',
      url,
      verdict,
    };
    console.log('[probe] D done:', JSON.stringify(verdict));
  }

  // ── M. minimize in the middle of a mount, restore, and expect it back ─────
  //
  // Minimizing is legal at any moment. The bar is not speed — a frame that has
  // stopped getting frames is allowed to be slow — it is that nothing BREAKS:
  // no rejected promise, no half-built page that stays half-built, no frame
  // that comes back showing the wrong page.
  if (runs('M')) {
    await inHost(win, 'window.__probe.teardown()', 'M: clear', 30000).catch(() => {});
    const mount = doc.getPageMount(offsets[vDoc]);
    const token = await inHost(
      win,
      `window.__probe.beginMountDocument(${JSON.stringify(mount)}, ${JSON.stringify(partition)}, ${GRID_COLUMNS}, ${GRID_GAP})`,
      'M: begin mount', 30000);

    win.minimize();
    const minimizedAt = Date.now();
    await new Promise((r) => setTimeout(r, 4000));

    // Asking a minimized window a question is itself part of the test: if the
    // renderer cannot answer, that is a fact to record, not a failure to hide.
    let settledWhileMinimized = null;
    try {
      settledWhileMinimized = await inHost(
        win, `window.__probe.mountSettled(${JSON.stringify(token)})`, 'M: settled?', 6000);
    } catch (err) {
      settledWhileMinimized = `the host did not answer while minimized (${err.message})`;
    }

    win.restore();
    win.focus();
    const restoredAt = Date.now();
    let afterRestore;
    try {
      afterRestore = await inHost(
        win, `window.__probe.awaitMount(${JSON.stringify(token)})`, 'M: await mount', 90000);
    } catch (err) {
      afterRestore = { ok: false, error: String(err.message) };
    }

    // And the other half: a frame that was ALREADY mounted, taken away and
    // brought back. Same page count, same rectangles, still answering.
    let survivedRoundTrip = null;
    if (afterRestore && afterRestore.ok) {
      win.minimize();
      await new Promise((r) => setTimeout(r, 1500));
      win.restore();
      win.focus();
      try {
        const again = await inHost(
          win,
          `window.__probe.mountDocument(${JSON.stringify(doc.getPageMount(0))}, ${JSON.stringify(partition)}, ${GRID_COLUMNS}, ${GRID_GAP}, true)`,
          'M: mount after restore', 60000);
        survivedRoundTrip = { mountedAfterRestore: true, pages: again.pages.length };
      } catch (err) {
        survivedRoundTrip = { mountedAfterRestore: false, error: String(err.message) };
      }
    }
    await inHost(win, 'window.__probe.teardown()', 'M: teardown', 30000).catch(() => {});

    results.probes.M_minimizeRestore = {
      what: 'the window minimized in the middle of a mount, then restored',
      document: mount.document,
      documentPages: mount.documentPageCount,
      settledWhileMinimized,
      minimizedForMs: restoredAt - minimizedAt,
      completedAfterRestore: !!(afterRestore && afterRestore.ok),
      pagesAfterRestore: afterRestore && afterRestore.ok ? afterRestore.result.pages.length : null,
      error: afterRestore && !afterRestore.ok ? afterRestore.error : null,
      alreadyMountedFrameSurvived: survivedRoundTrip,
    };
    console.log('[probe] M done:', JSON.stringify(results.probes.M_minimizeRestore.completedAfterRestore));
  }

  // ── N. does ANALYSIS care about the window at all? ────────────────────────
  //
  // The one kind of slowness a user would still feel after restoring is a
  // pagination that did not progress while they were away — a 183-page book
  // that should open in seconds taking minutes. quire lays a book out in an
  // OFFSCREEN host, which is a different surface from any of the display
  // candidates. This checks that separation instead of asserting it.
  if (runs('N')) {
    const second = await Quire.openDocument(stampedPath);
    win.minimize();
    const t0 = Date.now();
    let layoutReport = null;
    let error = null;
    try {
      layoutReport = await second.layout(GEOMETRY);
    } catch (err) {
      error = String(err.message);
    }
    const elapsed = Date.now() - t0;
    win.restore();
    win.focus();
    const pages = layoutReport ? second.countPages() : 0;
    await second.close();
    results.probes.N_analysisWhileMinimized = {
      what: 'a whole second pagination on the offscreen analysis host, with the app window minimized',
      windowState: 'minimized for the entire layout',
      pages,
      layoutMs: layoutReport ? Math.round(layoutReport.layoutMs) : null,
      wallClockMs: elapsed,
      msPerPage: pages ? ms(elapsed / pages) : null,
      unplaced: layoutReport ? layoutReport.unplaced.length : null,
      comparisonVisibleMsPerPage: ms(results.layoutMs / results.pageCount),
      error,
    };
    console.log('[probe] N done:', JSON.stringify(results.probes.N_analysisWhileMinimized.msPerPage));
  }

  // ── V. does the frame have to be on screen? ───────────────────────────────
  if (runs('V')) {
    const placements = {
      'fully visible': '',
      'half below the fold': 'position:relative;top:450px;',
      'entirely below the fold': 'position:relative;top:3000px;',
      'visibility:hidden': 'visibility:hidden;',
      'display:none': 'display:none;',
    };
    const table = {};
    for (const [name, css] of Object.entries(placements)) {
      const runs = [];
      for (let i = 0; i < VISIBILITY_REPEATS; i++) {
        try {
          runs.push(await inHost(
            win,
            `window.__probe.paginateAt(${JSON.stringify(vMount)}, ${JSON.stringify(partition)}, ${JSON.stringify(css)})`,
            `V: ${name} #${i + 1}`, 45000));
        } catch (err) {
          console.log(`[probe] V ${name} #${i + 1} REFUSED: ${err.message}`);
          runs.push({ refused: String(err.message) });
        }
      }
      const ok = runs.filter((r) => !r.refused);
      table[name] = {
        runs: runs.length,
        answered: ok.length,
        medianPresentMs: ok.length ? median(ok.map((r) => r.present)) : null,
        medianMsPerPage: ok.length ? median(ok.map((r) => r.msPerPage)) : null,
        medianPreludeMs: ok.length ? median(ok.map((r) => r.prelude)) : null,
        refusals: runs.filter((r) => r.refused).map((r) => r.refused),
      };
      console.log(`[probe] V ${name}: ${JSON.stringify(table[name].medianMsPerPage)} ms/page`);
    }
    results.probes.V_visibility = {
      what: 'the same document paginated in a frame at five placements, nothing else mounted',
      document: vMount.document,
      documentPages: vMount.documentPageCount,
      byPlacement: table,
    };
    // A placement that never paginates leaves a promise pending in the host
    // page, and a teardown queued behind it may never answer either. V runs
    // last for exactly that reason, so a stuck teardown ends the probe rather
    // than costing it a result.
    await inHost(win, 'window.__probe.teardown()', 'V: teardown', 15000)
      .catch((err) => console.log(`[probe] V teardown: ${err.message}`));
  }

  await doc.close();
  win.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function hostHeapMb(win) {
  const usage = await win.webContents.executeJavaScript(
    '(performance.memory ? performance.memory.usedJSHeapSize : 0)', true);
  const total = app.getAppMetrics().reduce((s, m) => s + (m.memory?.workingSetSize || 0), 0);
  return { hostJsHeapMb: Math.round(usage / 1048576), allProcessesWorkingSetMb: Math.round(total / 1024) };
}

app.on('window-all-closed', () => { /* the probe decides when it is done */ });

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    fails.push(String((err && err.stack) || err));
    console.error('[probe] FAILED:', err);
  }
  const out = JSON.stringify({ ...results, failures: fails }, null, 2);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, out, 'utf8');
    console.log(`[probe] evidence written to ${jsonOut}`);
  } else {
    console.log(out);
  }
  app.exit(fails.length === 0 ? 0 : 1);
});
